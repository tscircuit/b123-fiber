# Deployment

The [sandbox](https://b123.tscircuit.com) is a static Vercel frontend. The
[native service](https://b123-fiber-kernel.vercel.app/health) runs Python
build123d 0.13.0/OpenCascade 8 in a separate Vercel project. Browsing examples
uses the checked-in native meshes; editing and CAD file operations execute
complete plans on the service.

The frontend's root `vercel.json` builds `sandbox/dist`. Set `VITE_KERNEL_URL`
to change its default service, or select a URL in the sandbox's **Kernel**
settings. Private service tokens can be entered in the browser settings;
they are not saved in the static build.

See the [native hosting guide](../deployment/kernel/README.md) for Vercel
configuration, bundled native runtime libraries, font setup, and the tested
non-root Docker container. The kernel uses the canonical Python package in
this repository and its pinned dependency lockfile.

Hosted requests are capped at 4 MiB, and Vercel responses at 4.5 MB. The
sandbox caps hosted CAD uploads at 2 MiB to allow for base64 in durable plans.
Large or complex models need a local/container kernel selected in the sandbox.
The local file bridge accepts files up to 32 MiB.

Use complete plans for hosted requests. RPC handles, general file IDs and
native streams belong to one process and can disappear between serverless
requests. Imported plans embed their source CAD content and survive restarts.
For persistent RPC sessions and files, run the single-worker container.
