import { defineEvalConfig } from "eve/evals";

// A real coding turn against a cold sandbox (npm install of six tarballs, a
// doctor probe, then the model's own tool loop) does not fit in the default
// timeout.
//
// No `judge`: nothing here asks a model to grade a model. The verdict is
// pixels. No `reporters` yet either — there is one eval.
// The first run also pays for the template: docker image, six tarball installs,
// a software-renderer download and a doctor probe. 10 minutes was not enough
// once remediation was added; later runs reuse the cached template.
export default defineEvalConfig({ timeoutMs: 1_200_000 });
