#!/usr/bin/env python3
"""Dumps the ONNX graph contract that PROVENANCE.md records.

Tooling only: never imported or executed by the docs app, the example, or CI.

Usage: graph-dump.py <model.onnx>
"""
import collections
import json
import sys

import onnx


def value_info(x):
    t = x.type.tensor_type
    return {
        "name": x.name,
        "dtype": onnx.TensorProto.DataType.Name(t.elem_type),
        "dims": [d.dim_value if d.HasField("dim_value") else d.dim_param for d in t.shape.dim],
    }


def main(argv):
    if len(argv) != 2:
        print(f"usage: {argv[0]} <model.onnx>", file=sys.stderr)
        return 2
    model = onnx.load(argv[1])
    print(json.dumps({
        "ir_version": model.ir_version,
        "opsets": [(x.domain, x.version) for x in model.opset_import],
        "inputs": [value_info(x) for x in model.graph.input],
        "outputs": [value_info(x) for x in model.graph.output],
        "ops": dict(sorted(collections.Counter(n.op_type for n in model.graph.node).items())),
        "node_count": len(model.graph.node),
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
