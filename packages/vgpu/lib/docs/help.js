export const docsHelp = `Usage: vgpu docs <command> [args] [flags]

Commands:
  ls [path]                  List packages or docs under a virtual path
  cat <path|symbol>          Print docs by virtual path or unique symbol
  grep [-i] [--package <pkg>] <pattern>
                             Search docs content; case-sensitive unless -i is used
  find <query>               Find symbols and docs paths by substring
  path <symbol|path>         Resolve a symbol or virtual path for shell usage
  symbols                    List indexed symbols
  help                       Show this help

Start here: vgpu docs cat getting-started.md

Examples:
  vgpu docs ls
  vgpu docs ls /@vgpu/core
  vgpu docs cat /@vgpu/core/Buffer.docs.md
  vgpu docs grep -i --package @vgpu/wgsl minify
  vgpu docs path Buffer`;
