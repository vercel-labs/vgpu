# Camera

A `Camera` is a plain value that contains the data shaders need to draw from a viewpoint.

It has a `viewProjectionMatrix`, a 16-element column-major `Float32Array`, and a `position`, a 3-element vector in world space. Camera factories compute the matrix once when you create the camera.

The returned camera object is frozen, so its fields cannot be replaced. The typed-array buffers are not frozen; mutating them after creation is undefined behavior. Copy a matrix or position first if you need your own editable snapshot.
