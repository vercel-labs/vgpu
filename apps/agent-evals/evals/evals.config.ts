import { defineEvalConfig } from "eve/evals";

// A real coding turn against a cold sandbox (npm install of six tarballs, a
// doctor probe, then the model's own tool loop) does not fit in the default
// timeout.
//
// No `judge`: nothing here asks a model to grade a model. The verdict is
// pixels. No `reporters` yet either — there is one eval.
export default defineEvalConfig({ timeoutMs: 600_000 });
