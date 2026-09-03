export const docsHelp = `Usage: vgpu docs <command> [args] [flags]

Start here: vgpu docs cat getting-started.md   (the guide for using the latest API correctly)
Finishing or opening a PR: vgpu docs cat shipping-to-production   (gates, measure, free defaults, propose the rest)

Commands:
  ls [path]                  List packages or docs under a virtual path
  cat <path|symbol>          Print docs by virtual path or unique symbol
  grep [-i] [--package <pkg>] <pattern>
                             Search docs content; case-sensitive unless -i is used
  find <query>               Find docs by name, keyword, or phrase (all words must match)
  path <symbol|path>         Resolve a symbol or virtual path for shell usage
  symbols                    List indexed symbols
  help                       Show this help

Examples:
  vgpu docs cat getting-started.md
  vgpu docs ls /guides
  vgpu docs ls
  vgpu docs cat /@vgpu/core/Buffer.docs.md
  vgpu docs grep -i --package @vgpu/wgsl minify
  vgpu docs path Buffer`;
