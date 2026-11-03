"""Store an ONNX graph's large float32 weights as float16, computed in float32.

    .venv/bin/python scripts/fp16_weights.py IN.onnx OUT.onnx

Each large initializer W becomes a float16 initializer W_fp16 plus a
Cast(W_fp16 -> float32) node producing W, so every consumer is unchanged.
onnxruntime constant-folds the Casts when the session is created: the file is
half the size, inference still runs in float32, and no fp16 kernels are needed
(the WASM CPU backend has few of them).

Only the rounding of the weights changes. Small tensors (biases, norms,
scalars) stay float32; they cost little and are the most sensitive.
"""
import sys

import numpy as np
import onnx
from onnx import helper, numpy_helper

MIN_ELEMENTS = 1024
FP16_MAX = 65504.0


def convert(src: str, dst: str) -> None:
    model = onnx.load(src)
    graph = model.graph
    keep, casts, converted = [], [], 0
    for init in graph.initializer:
        if init.data_type != onnx.TensorProto.FLOAT:
            keep.append(init)
            continue
        arr = numpy_helper.to_array(init)
        if arr.size < MIN_ELEMENTS or np.abs(arr).max(initial=0) > FP16_MAX:
            keep.append(init)
            continue
        half = numpy_helper.from_array(arr.astype(np.float16), init.name + "_fp16")
        keep.append(half)
        casts.append(helper.make_node("Cast", [half.name], [init.name], to=onnx.TensorProto.FLOAT,
                                      name=init.name + "_to_fp32"))
        converted += 1
    del graph.initializer[:]
    graph.initializer.extend(keep)
    # Casts first so they precede their consumers (graph nodes must be topologically sorted).
    nodes = casts + list(graph.node)
    del graph.node[:]
    graph.node.extend(nodes)
    onnx.checker.check_model(model)
    onnx.save(model, dst)
    print(f"{src} -> {dst}: {converted} weights to fp16")


if __name__ == "__main__":
    convert(sys.argv[1], sys.argv[2])
