#!/usr/bin/env python3
"""Canonical, name-independent structural digest of an ONNX graph.

Tooling only: never imported or executed by the docs app, the example, or CI.

Why this exists
---------------
`tf2onnx` is **not** byte-reproducible, even for a fixed input file, a fixed
toolchain and a fixed machine. Converting the same `hand_detector.tflite` three
times in a row produces three files of identical length and three different
SHA-256 digests. The cause is small and boring: tf2onnx names generated tensors
from a process-global counter (`scales__278` in one run, `scales__301` in the
next), so a differing number of earlier internal name allocations shifts every
later name. The operators, the topology and the weights are unchanged.

A raw byte digest therefore cannot be the reproducibility contract; it can only
be an integrity check on one particular staged copy. This script provides the
contract instead: a digest over everything that actually defines the model, with
every generated name normalised away.

What is hashed
--------------
  * the opset imports,
  * the graph inputs/outputs in order, by *position*, dtype and shape
    (their names are part of the calling contract, so they are hashed too),
  * every node in topological order: op type, its position, its attributes, and
    the *positional* identity of each input/output edge rather than its name,
  * every initializer: dtype, shape and raw tensor bytes, hashed in the order
    the graph consumes them.

Two graphs with the same digest compute the same function with the same weights.

Usage: graph-digest.py <model.onnx> [<model.onnx> ...]
"""
from __future__ import annotations

import hashlib
import json
import sys

import onnx


def _attr_repr(attr: onnx.AttributeProto) -> object:
    """Attribute value, with tensor payloads reduced to a digest."""
    kind = attr.type
    if kind == onnx.AttributeProto.FLOAT:
        return ["f", float(attr.f)]
    if kind == onnx.AttributeProto.INT:
        return ["i", int(attr.i)]
    if kind == onnx.AttributeProto.STRING:
        return ["s", attr.s.decode("utf-8", "replace")]
    if kind == onnx.AttributeProto.FLOATS:
        return ["fs", [float(v) for v in attr.floats]]
    if kind == onnx.AttributeProto.INTS:
        return ["is", [int(v) for v in attr.ints]]
    if kind == onnx.AttributeProto.STRINGS:
        return ["ss", [v.decode("utf-8", "replace") for v in attr.strings]]
    if kind == onnx.AttributeProto.TENSOR:
        return ["t", _tensor_repr(attr.t)]
    return ["other", int(kind), attr.SerializeToString().hex()]


def _tensor_repr(t: onnx.TensorProto) -> list:
    """dtype, shape and a digest of the raw payload — never the tensor's name."""
    payload = t.raw_data
    if not payload:
        # Non-raw storage: serialise the numeric fields deterministically.
        payload = b"".join(
            bytes(str(list(getattr(t, field))), "utf-8")
            for field in ("float_data", "int32_data", "int64_data", "double_data", "uint64_data")
            if getattr(t, field)
        )
    return [
        int(t.data_type),
        [int(d) for d in t.dims],
        hashlib.sha256(payload).hexdigest(),
    ]


def _value_info(v: onnx.ValueInfoProto) -> list:
    tt = v.type.tensor_type
    dims = [d.dim_value if d.HasField("dim_value") else d.dim_param for d in tt.shape.dim]
    return [v.name, int(tt.elem_type), dims]


def canonical(model: onnx.ModelProto) -> dict:
    graph = model.graph

    # Identity for every edge, chosen so that a renamed or reordered tensor maps
    # to the same label in both graphs:
    #   * graph inputs      -> their position in the signature,
    #   * initializers      -> a digest of their *contents* (order-independent),
    #   * node outputs      -> the producing node's topological position.
    slot: dict[str, str] = {}
    for i, v in enumerate(graph.input):
        slot[v.name] = f"in:{i}"
    for t in graph.initializer:
        rep = _tensor_repr(t)
        slot[t.name] = "const:" + hashlib.sha256(
            json.dumps(rep, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()[:32]
    for i, node in enumerate(graph.node):
        for j, out in enumerate(node.output):
            if out:
                slot[out] = f"n{i}:{j}"

    def edge(name: str) -> str:
        if not name:
            return "-"
        return slot.get(name, f"ext:{name}")

    # Initializers are emitted sorted by their content label, so neither the
    # converter's emission order nor its generated names can affect the digest.
    initializers = sorted(
        ([slot[t.name], _tensor_repr(t)] for t in graph.initializer),
        key=lambda kv: kv[0],
    )

    nodes = []
    for i, node in enumerate(graph.node):
        nodes.append([
            i,
            node.op_type,
            node.domain,
            [edge(x) for x in node.input],
            [edge(x) for x in node.output],
            sorted(([a.name, _attr_repr(a)] for a in node.attribute), key=lambda kv: kv[0]),
        ])

    return {
        "irVersion": model.ir_version,
        "opsets": sorted([[o.domain, o.version] for o in model.opset_import]),
        "inputs": [_value_info(v) for v in graph.input],
        "outputs": [_value_info(v) for v in graph.output],
        "nodes": nodes,
        "initializers": initializers,
    }


def digest(path: str) -> tuple[str, dict]:
    model = onnx.load(path)
    form = canonical(model)
    blob = json.dumps(form, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(blob).hexdigest(), form


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(f"usage: {argv[0]} <model.onnx> [<model.onnx> ...]", file=sys.stderr)
        return 2
    results = []
    for path in argv[1:]:
        d, form = digest(path)
        results.append(d)
        print(f"{d}  {path}  "
              f"({len(form['nodes'])} nodes, {len(form['initializers'])} initializers)")
    if len(results) > 1:
        print("identical" if len(set(results)) == 1 else "DIFFERENT")
        return 0 if len(set(results)) == 1 else 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
