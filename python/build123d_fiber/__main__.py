"""Run with python -m build123d_fiber or build123d-fiber-kernel."""

import argparse
import os

import uvicorn

from .server import create_app


def main():
    parser = argparse.ArgumentParser(description="Native build123d/OpenCascade geometry service")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--workspace-root", default=os.getcwd())
    parser.add_argument("--origin", action="append", help="Allowed browser origin (repeatable)")
    arguments = parser.parse_args()
    uvicorn.run(create_app(arguments.workspace_root, origins=arguments.origin), host=arguments.host, port=arguments.port)


if __name__ == "__main__":
    main()
