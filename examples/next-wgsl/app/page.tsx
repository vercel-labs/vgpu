import shader from "./shader.wgsl";

export default function Page() {
  return (
    <main>
      <h1>@vgpu/wgsl + Next.js Turbopack</h1>
      <p>Shader length: {shader.length}</p>
      <pre>{shader.slice(0, 500)}</pre>
    </main>
  );
}
