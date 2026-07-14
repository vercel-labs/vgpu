import shader from "./shader.wgsl";

export default function Page() {
  return (
    <main>
      <h1>@vgpu/wgsl + Next.js Turbopack</h1>
      <p>Shader length: {shader.wgsl.length}</p>
      <pre>{shader.wgsl.slice(0, 500)}</pre>
    </main>
  );
}
