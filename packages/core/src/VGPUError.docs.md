# VGPUError

`VGPUError` is the structured error base class. Every core error has a stable
`code`, human message, optional `fix`, and optional `where` field so agents can
handle failures as data instead of parsing prose.
