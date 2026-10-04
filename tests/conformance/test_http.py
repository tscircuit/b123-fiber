"""Exercise the published CLI and real loopback HTTP/JSON transport."""

from concurrent.futures import ThreadPoolExecutor
import json
import math
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
TOKEN = "conformance-fixture-token"


class HttpConformance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workspace = tempfile.TemporaryDirectory(prefix="build123d-http-conformance-")
        cls.logs = tempfile.TemporaryFile()
        with socket.socket() as reserve:
            reserve.bind(("127.0.0.1", 0))
            port = reserve.getsockname()[1]
        cls.base = f"http://127.0.0.1:{port}"
        environment = dict(os.environ)
        environment["PYTHONPATH"] = str(ROOT / "python")
        environment["BUILD123D_FIBER_TOKEN"] = TOKEN
        cls.process = subprocess.Popen(
            [sys.executable, "-m", "build123d_fiber", "--port", str(port), "--workspace-root", cls.workspace.name],
            cwd=ROOT, env=environment, stdout=cls.logs, stderr=cls.logs,
        )
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                status, body = cls.request("GET", "/health")
                if status == 200 and body["status"] == "ok":
                    return
            except (URLError, TimeoutError):
                pass
            if cls.process.poll() is not None:
                break
            time.sleep(0.05)
        cls.process.terminate()
        cls.process.wait(timeout=5)
        cls.logs.seek(0)
        logs = cls.logs.read().decode(errors="replace")
        cls.logs.close()
        cls.workspace.cleanup()
        raise RuntimeError(f"Native HTTP service did not start: {logs}")

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        try:
            cls.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cls.process.kill()
            cls.process.wait(timeout=5)
        cls.logs.close()
        cls.workspace.cleanup()

    @classmethod
    def request(cls, method, path, body=None, authenticated=True, headers=None):
        request_headers = {"Content-Type": "application/json", **(headers or {})}
        if authenticated:
            request_headers["Authorization"] = f"Bearer {TOKEN}"
        request = Request(cls.base + path, data=None if body is None else json.dumps(body, allow_nan=False).encode(), headers=request_headers, method=method)
        try:
            with urlopen(request, timeout=15) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    def setUp(self):
        status, body = self.request("POST", "/rpc", {"op": "clear"})
        self.assertEqual(status, 200)
        self.assertEqual(body, {"value": None})

    def test_api_and_health_are_real_json(self):
        status, health = self.request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(health["version"], "0.13.0")
        status, inventory = self.request("GET", "/api")
        self.assertEqual(status, 200)
        self.assertEqual(len(inventory["exports"]), 203)
        self.assertEqual(set(inventory["exports"]), set(inventory["symbols"]))
        self.assertIn("make_cylinder", inventory["symbols"]["Solid"]["members"])
        self.assertIn("volume", inventory["symbols"]["Box"]["members"])

    def test_native_render_over_http(self):
        scene = {"version": 1, "children": [{"type": "BuildPart", "props": {}, "children": [
            {"type": "Box", "props": {"args": [10, 8, 4]}, "children": []},
            {"type": "Cylinder", "props": {"args": [2, 8], "mode": {"$enum": "Mode.SUBTRACT"}}, "children": []},
        ]}]}
        status, rendered = self.request("POST", "/render", {"plan": scene, "tolerance": 0.1})
        self.assertEqual(status, 200)
        self.assertEqual(len(rendered["meshes"]), 1)
        mesh = rendered["meshes"][0]
        self.assertAlmostEqual(mesh["volume"], 320 - math.pi * 4 * 4, places=6)
        self.assertTrue(mesh["valid"])
        self.assertTrue(mesh["indices"])
        self.assertTrue(mesh["edges"])
        self.assertEqual(rendered["bounds"], {"min": [-5, -4, -2], "max": [5, 4, 2]})

    def test_native_rpc_reference_and_release_over_http(self):
        status, built = self.request("POST", "/rpc", {"op": "construct", "name": "Box", "args": [4, 6, 8]})
        self.assertEqual(status, 200)
        reference = built["value"]
        self.assertEqual(reference["kind"], "Box")
        status, value = self.request("POST", "/rpc", {"op": "get", "target": reference, "name": "volume"})
        self.assertEqual(status, 200)
        self.assertAlmostEqual(value["value"], 192, places=6)
        status, released = self.request("POST", "/rpc", {"op": "release", "target": reference})
        self.assertEqual((status, released), (200, {"value": None}))
        status, error = self.request("POST", "/rpc", {"op": "get", "target": reference, "name": "volume"})
        self.assertEqual(status, 422)
        self.assertEqual(error["error"]["type"], "ValueError")
        self.assertIn("Unknown or released native reference", error["error"]["message"])
        self.assertEqual(error["error"]["path"], "rpc.get.volume")

    def test_native_errors_are_structured_non_success_responses(self):
        for path, body, expected_path, error_type in (
            ("/rpc", {"op": "construct", "name": "Box", "kwargs": {"length": 2}}, "rpc.construct.Box", "TypeError"),
            ("/rpc", {"op": "construct", "name": "UnknownShape"}, "rpc.construct.UnknownShape", "ValueError"),
            ("/render", {"plan": {"version": 2, "children": []}}, "plan", "ValueError"),
            ("/render", {"plan": {"version": 1, "children": []}, "tolerance": 0}, "tolerance", "ValueError"),
        ):
            with self.subTest(path=path, body=body):
                status, response = self.request("POST", path, body)
                self.assertEqual(status, 422)
                self.assertEqual(response["error"]["path"], expected_path)
                self.assertEqual(response["error"]["type"], error_type)
                self.assertTrue(response["error"]["message"])

    def test_token_authentication_on_actual_transport(self):
        for path in ("/health", "/api"):
            with self.subTest(path=path):
                status, error = self.request("GET", path, authenticated=False)
                self.assertEqual(status, 401)
                self.assertEqual(error["error"]["type"], "Unauthorized")
        status, error = self.request("POST", "/rpc", {"op": "clear"}, authenticated=False, headers={"Authorization": "Bearer wrong-token"})
        self.assertEqual(status, 401)
        self.assertEqual(error["error"]["path"], "authorization")

    def test_parallel_native_render_requests_remain_independent(self):
        def render_size(length):
            scene = {"version": 1, "children": [{"type": "BuildPart", "props": {}, "children": [
                {"type": "Box", "props": {"args": [length, 3, 4]}, "children": []},
                {"type": "Cylinder", "props": {"args": [0.5, 8], "mode": {"$enum": "Mode.SUBTRACT"}}, "children": []},
            ]}]}
            return length, self.request("POST", "/render", {"plan": scene})
        with ThreadPoolExecutor(max_workers=4) as workers:
            results = list(workers.map(render_size, range(2, 10)))
        for length, (status, response) in results:
            with self.subTest(length=length):
                self.assertEqual(status, 200)
                self.assertEqual(len(response["meshes"]), 1)
                self.assertTrue(response["meshes"][0]["valid"])
                self.assertAlmostEqual(response["meshes"][0]["volume"], length * 12 - math.pi, places=6)
                self.assertEqual(response["bounds"]["min"][0], -length / 2)
                self.assertEqual(response["bounds"]["max"][0], length / 2)


if __name__ == "__main__":
    unittest.main()
