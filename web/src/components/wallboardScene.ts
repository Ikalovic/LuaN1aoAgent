import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { layoutGraph } from "../graphLayout";
import type { GraphEdge, GraphNode } from "../types";

export function createWallboardScene(container: HTMLDivElement, labels: HTMLDivElement, runtimeDir: string, onSelect: (id: string) => void, onFailure: (reason: string) => void, onInteraction: () => void) {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
  renderer.setClearColor(0x090d10, 0); renderer.setPixelRatio(Math.min(devicePixelRatio, innerWidth >= 3000 ? 1 : 1.5));
  renderer.domElement.setAttribute("aria-label", "真实资产三维拓扑"); container.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-300, 300, 200, -200, 1, 20000);
  camera.position.set(400, 490, 600);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.minPolarAngle = THREE.MathUtils.degToRad(35); controls.maxPolarAngle = THREE.MathUtils.degToRad(65);
  controls.enableDamping = false; controls.minZoom = .15; controls.maxZoom = 5; controls.enableRotate = true;
  scene.add(new THREE.HemisphereLight(0xcde2ec, 0x19262a, 2));
  const light = new THREE.DirectionalLight(0xffffff, 2.5); light.position.set(-300, 500, 400); scene.add(light);
  const geometries = { Host: new THREE.BoxGeometry(72, 72, 48), Service: new THREE.CylinderGeometry(29, 33, 16, 6), WebEndpoint: new THREE.BoxGeometry(74, 16, 46), other: new THREE.CylinderGeometry(28, 32, 18, 4) };
  const colors: Record<string, number> = { Host: 0x99d7ef, Service: 0x8ee9d2, WebEndpoint: 0xe8c991 };
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  const material = (type: string, selected: boolean, pulse: boolean) => {
    const key = type + selected + pulse;
    if (!materials.has(key)) materials.set(key, new THREE.MeshStandardMaterial({ color: selected || pulse ? 0x94efd5 : 0x678b92, metalness: .7, roughness: .2, transparent: true, opacity: selected || pulse ? .8 : type === "Host" ? .72 : .38, depthWrite: false, emissive: selected || pulse ? 0x62c5a9 : colors[type] ?? 0x99d7ef, emissiveIntensity: selected || pulse ? .35 : .07 }));
    return materials.get(key)!;
  };
  const outlines = Object.fromEntries(Object.entries(geometries).map(([type, geometry]) => [type, new THREE.EdgesGeometry(geometry)]));
  const accents = new Map<string, THREE.LineBasicMaterial>();
  const stripGeo = new THREE.BoxGeometry(50, 2, 1);
  const stripMat = new THREE.MeshBasicMaterial({ color: 0xcaedf5 });
  const baseGeo = new THREE.CylinderGeometry(51, 51, 2, 6);
  const baseOutline = new THREE.EdgesGeometry(baseGeo);
  const baseMat = new THREE.MeshBasicMaterial({ color: 0x91d6d0, transparent: true, opacity: .035, depthWrite: false });
  const serviceInset = new THREE.EdgesGeometry(new THREE.CylinderGeometry(23, 23, 1, 6));
  const endpointInset = new THREE.EdgesGeometry(new THREE.BoxGeometry(58, 1, 32));
  function decorate(mesh: THREE.Mesh, type: string) {
    if (!accents.has(type)) accents.set(type, new THREE.LineBasicMaterial({ color: colors[type] ?? 0x71b9f5, transparent: true, opacity: .85 }));
    const accent = accents.get(type)!;
    mesh.add(new THREE.LineSegments(outlines[type] ?? outlines.other, accent));
    const base = new THREE.Mesh(baseGeo, baseMat);
    base.position.y = type === "Host" ? -42 : -18;
    base.add(new THREE.LineSegments(baseOutline, accent));
    mesh.add(base);
    if (type === "Host") for (let row = 0; row < 4; row++) {
      const strip = new THREE.Mesh(stripGeo, stripMat);
      strip.position.set(0, 24 - row * 15, 24.6);
      mesh.add(strip);
    }
    if (type === "Service" || type === "WebEndpoint") {
      const inset = new THREE.LineSegments(type === "Service" ? serviceInset : endpointInset, accent);
      inset.position.y = 9;
      mesh.add(inset);
    }
    mesh.traverse((object) => { object.userData.nodeId = mesh.userData.nodeId; });
  }
  const meshes = new Map<string, THREE.Mesh>();
  const positions = new Map<string, THREE.Vector3>();
  let edgeObjects: THREE.Line[] = [];
  let disposed = false, fitted = false, active = false, hidden = document.hidden, frame = 0, lastFrame = 0, request: AbortController | undefined;
  let width = 1, height = 1, extent = 400, selectedId: string | undefined;
  let nodes: GraphNode[] = [], edges: GraphEdge[] = [], pulseIds: string[] = [], edgeRefs: string[][] = [];
  let fpsStart = 0, frames = 0, degraded = false;
  const project = new THREE.Vector3();
  function renderLabels() {
    const occupied: Array<{ x: number; y: number; w: number }> = [];
    const elements = Array.from(labels.querySelectorAll<HTMLButtonElement>("[data-node]"));
    elements.sort((a, b) => Number(b.dataset.node === selectedId) - Number(a.dataset.node === selectedId));
    for (const el of elements) {
      const position = positions.get(el.dataset.node!);
      if (!position) { el.hidden = true; continue; }
      project.copy(position); project.y += 72; project.project(camera);
      const x = (project.x * .5 + .5) * width, y = (-project.y * .5 + .5) * height;
      const w = el.offsetWidth || parseFloat(getComputedStyle(el).maxWidth) || 156;
      const visible = project.z >= -1 && project.z <= 1 && x >= w / 2 + 4 && x <= width - w / 2 - 4 && y > 8 && y < height - 40 && !occupied.some((p) => Math.abs(p.x - x) < (p.w + w) / 2 + 8 && Math.abs(p.y - y) < 40);
      el.hidden = !visible;
      if (visible) { el.style.left = `${x}px`; el.style.top = `${y}px`; occupied.push({ x, y, w }); }
    }
  }
  function draw(now = performance.now()) {
    frame = 0; if (disposed || hidden) return;
    if (active && now - lastFrame < 1000 / 30) { frame = requestAnimationFrame(draw); return; }
    lastFrame = active ? now - ((now - lastFrame) % (1000 / 30)) : now;
    if (active) {
      if (!degraded) accents.forEach((accent) => { accent.opacity = .78 + Math.sin(now / 1800) * .15; });
      if (!fpsStart) fpsStart = now; frames++;
      if (now - fpsStart >= 5000) {
        if (frames * 1000 / (now - fpsStart) < 24) { if (degraded) { onFailure("持续低帧率，已切换二维"); return; } degraded = true; renderer.setPixelRatio(1); }
        fpsStart = now; frames = 0;
      }
    }
    renderer.render(scene, camera); renderLabels();
    if (active) frame = requestAnimationFrame(draw);
  }
  function invalidate() { if (!frame && !disposed && !hidden) frame = requestAnimationFrame(draw); }
  function fit() {
    const box = new THREE.Box3(); positions.forEach((position) => box.expandByPoint(position));
    const center = positions.size ? box.getCenter(new THREE.Vector3()) : new THREE.Vector3();
    const size = positions.size ? box.getSize(new THREE.Vector3()) : new THREE.Vector3(450, 0, 300);
    extent = Math.max(220, size.z * .68 + size.x * .45 + 90, (size.x + size.z * .5 + 140) / Math.max(.3, width / height) / 2);
    controls.target.copy(center); camera.position.copy(center).add(new THREE.Vector3(120, 700, 1100)); camera.zoom = 1; resize(); controls.update(); camera.updateMatrixWorld();
    // Fit occupied geometry, not the empty corners of a sparse topology's bounding box.
    const projectedBounds = new THREE.Box3();
    positions.forEach((position) => {
      for (const dx of [-58, 58]) for (const dz of [-58, 58]) for (const dy of [-44, 82]) {
        projectedBounds.expandByPoint(position.clone().add(new THREE.Vector3(dx, dy, dz)).project(camera));
      }
    });
    if (positions.size) {
      const projectedSize = projectedBounds.getSize(new THREE.Vector3());
      const projectedCenter = projectedBounds.getCenter(new THREE.Vector3());
      const shift = new THREE.Vector3(projectedCenter.x, projectedCenter.y, 0).unproject(camera).sub(new THREE.Vector3(0, 0, 0).unproject(camera));
      camera.position.add(shift); controls.target.add(shift);
      camera.zoom = THREE.MathUtils.clamp(1.76 / Math.max(.1, projectedSize.x, projectedSize.y), .15, 5);
    }
    camera.updateProjectionMatrix(); controls.update(); invalidate();
  }
  function resize() { if (disposed) return; width = Math.max(1, container.clientWidth); height = Math.max(1, container.clientHeight); const aspect = width / height; camera.left = -extent * aspect; camera.right = extent * aspect; camera.top = extent; camera.bottom = -extent; camera.updateProjectionMatrix(); renderer.setSize(width, height); invalidate(); }
  function restyle() {
    nodes.forEach((node) => { const mesh = meshes.get(node.id); if (mesh) mesh.material = material(node.type, selectedId === node.id, pulseIds.includes(node.id)); });
    const highlighted = new Set(edges.filter((edge) => edgeRefs.some((refs) => refs.includes(edge.from) && refs.includes(edge.to))).slice(0, 3));
    edgeObjects.forEach((line, index) => { const edge = edges[index]; (line.material as THREE.LineBasicMaterial).color.setHex(highlighted.has(edge) ? 0xf2c066 : edge && (selectedId === edge.from || selectedId === edge.to) ? 0x53d6bd : 0xb7d9ee); }); invalidate();
  }
  function rebuildEdges() {
    edgeObjects.forEach((line) => { scene.remove(line); line.geometry.dispose(); (line.material as THREE.Material).dispose(); });
    edgeObjects = edges.map((edge) => { const from = positions.get(edge.from)!, to = positions.get(edge.to)!; const mid = new THREE.Vector3(to.x, 2, from.z); const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([from.clone().setY(2), mid, to.clone().setY(2)]), new THREE.LineBasicMaterial({ color: 0xb7d9ee, transparent: true, opacity: .92 })); scene.add(line); return line; }); restyle();
  }
  async function update(nextNodes: GraphNode[], nextEdges: GraphEdge[]) {
    request?.abort(); request = new AbortController(); const currentRequest = request;
    const layout = await layoutGraph(nextNodes, nextEdges, "operation", request.signal, runtimeDir);
    if (disposed || currentRequest.signal.aborted || !layout) return;
    nodes = nextNodes; edges = nextEdges;
    const ids = new Set(nodes.map((node) => node.id));
    meshes.forEach((mesh, id) => { if (!ids.has(id)) { scene.remove(mesh); meshes.delete(id); positions.delete(id); } });
    nodes.forEach((node) => {
      if (!positions.has(node.id)) { const pos = layout[node.id] ?? { x: 0, y: 0 }; positions.set(node.id, new THREE.Vector3(pos.x * 1.18, 44, pos.y * 1.35)); }
      let mesh = meshes.get(node.id);
      if (!mesh) { mesh = new THREE.Mesh(geometries[node.type as keyof typeof geometries] ?? geometries.other, material(node.type, false, false)); mesh.userData.nodeId = node.id; decorate(mesh, node.type); meshes.set(node.id, mesh); scene.add(mesh); }
      mesh.position.copy(positions.get(node.id)!);
    });
    rebuildEdges(); if (!fitted && nodes.length) { fit(); fitted = true; } invalidate();
  }
  const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2(); let downX = 0, downY = 0;
  const down = (event: PointerEvent) => { downX = event.clientX; downY = event.clientY; onInteraction(); };
  const pick = (event: PointerEvent) => { if (hidden || Math.hypot(event.clientX - downX, event.clientY - downY) > 5) return; const rect = renderer.domElement.getBoundingClientRect(); pointer.set((event.clientX - rect.left) / width * 2 - 1, -(event.clientY - rect.top) / height * 2 + 1); raycaster.setFromCamera(pointer, camera); const hit = raycaster.intersectObjects([...meshes.values()])[0]; if (hit) onSelect(hit.object.userData.nodeId); };
  const visibility = () => { hidden = document.hidden; controls.enabled = !hidden; fpsStart = 0; frames = 0; cancelAnimationFrame(frame); frame = 0; if (!hidden) invalidate(); };
  const lost = (event: Event) => { event.preventDefault(); onFailure("三维上下文已丢失，已切换二维"); };
  controls.addEventListener("change", invalidate); renderer.domElement.addEventListener("pointerdown", down); renderer.domElement.addEventListener("pointerup", pick); renderer.domElement.addEventListener("webglcontextlost", lost); document.addEventListener("visibilitychange", visibility);
  const observer = new ResizeObserver(resize); observer.observe(container); resize(); fit();
  void document.fonts.ready.then(invalidate);
  return {
    update, fit, zoom: (factor: number) => { camera.zoom = THREE.MathUtils.clamp(camera.zoom * factor, .15, 5); camera.updateProjectionMatrix(); invalidate(); },
    presentation: (selection: string | undefined, pulses: string[], refs: string[][], motion: boolean) => { selectedId = selection; pulseIds = pulses; edgeRefs = refs; if (active !== motion) { active = motion; fpsStart = 0; frames = 0; } restyle(); },
    dispose: () => { disposed = true; request?.abort(); cancelAnimationFrame(frame); observer.disconnect(); controls.dispose(); renderer.domElement.removeEventListener("pointerdown", down); renderer.domElement.removeEventListener("pointerup", pick); renderer.domElement.removeEventListener("webglcontextlost", lost); document.removeEventListener("visibilitychange", visibility); edgeObjects.forEach((line) => { line.geometry.dispose(); (line.material as THREE.Material).dispose(); }); Object.values(geometries).forEach((geometry) => geometry.dispose()); Object.values(outlines).forEach((geometry) => geometry.dispose()); accents.forEach((m) => m.dispose()); materials.forEach((m) => m.dispose()); stripGeo.dispose(); stripMat.dispose(); baseGeo.dispose(); baseOutline.dispose(); baseMat.dispose(); serviceInset.dispose(); endpointInset.dispose(); renderer.dispose(); renderer.domElement.remove(); }
  };
}
