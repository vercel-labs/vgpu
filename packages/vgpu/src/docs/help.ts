export const rootHelp = `Usage: vgpu <command> [args]

Commands:
  docs    Explore generated vgpu documentation

Run "vgpu docs --help" for docs commands.`;

export const docsHelp = `Usage: vgpu docs <command> [args] [flags]

Commands:
  ls [path]                  List packages or docs under a virtual path
  cat <path|symbol>          Print docs by virtual path or unique symbol
  grep [--package <pkg>] <pattern>
                             Search docs content
  find <term>                Find symbols and docs paths by substring
  path <symbol>              Resolve a unique symbol to a virtual path
  symbols                    List indexed symbols

Examples:
  vgpu docs ls
  vgpu docs ls /@vgpu/core
  vgpu docs cat /@vgpu/core/Buffer.docs.md
  vgpu docs cat Buffer
  vgpu docs grep --package @vgpu/wgsl minify`;
