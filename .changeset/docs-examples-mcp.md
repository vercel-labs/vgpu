---
"@vgpu/cli": patch
"vgpu": patch
---

Expose the existing documentation and verified examples workflows as two MCP tools. Add a local
`vgpu mcp` stdio server with opt-in, output-directory-confined example downloads and publish a
read-only Streamable HTTP endpoint at `https://vgpu.sh/api/mcp` using the stateless modern MCP
transport.
