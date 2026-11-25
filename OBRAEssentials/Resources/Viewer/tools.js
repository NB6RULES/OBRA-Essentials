// Improved interaction layer on top of the Online 3D Viewer engine:
//  - navigation: one finger orbits around the point you touch, two fingers pan and pinch-zoom
//    towards the pinch, double tap centres on a point (or frames everything on empty space);
//    mouse: left orbit, right/middle/shift pan, wheel zooms to the cursor
//  - view cube (tap a face, edge or corner) with a home button, and an axis triad
//  - tools: Inspect (tap a face or edge), Measure (two picks, snapped to holes, edges and faces),
//    Section (X/Y/Z cut with hatched cut faces) and Frame
// viewer.js calls CSTools.attach(embeddedViewer) after every load.
(function () {
    'use strict';
    const T = window.T3;
    if (!T) { return; }

    const $ = (id) => document.getElementById(id);
    const stage = $('stage');
    const ui = $('ui');
    const dims = $('dims');
    const SVGNS = 'http://www.w3.org/2000/svg';

    const V = (x, y, z) => new T.Vector3(x, y, z);
    const fromC = (c) => new T.Vector3(c.x, c.y, c.z);
    const DEG = Math.PI / 180;

    let emb = null, viewer = null, nav = null, ctx = null;
    let modelR = 1, modelC = V(0, 0, 0);
    let overlay = null;          // THREE group for highlight meshes
    let anim = null;             // running camera animation
    let renderHooked = false;

    const state = {
        tool: 'inspect',
        selection: null,          // inspect feature
        picks: [],                // measure features
        section: { on: false, axis: 'y', t: 0.5, flip: false }
    };

    // ---------------------------------------------------------------- camera helpers

    function cam () { return nav.GetCamera(); }
    function camVecs () {
        const c = cam();
        const eye = fromC(c.eye), center = fromC(c.center), up = fromC(c.up).normalize();
        const fwd = center.clone().sub(eye);
        const dist = fwd.length();
        fwd.normalize();
        const right = fwd.clone().cross(up).normalize();
        const sup = right.clone().cross(fwd).normalize();
        return { eye, center, up, fwd, right, sup, dist, fov: c.fov };
    }
    function setCam (eye, center, up) {
        const c = cam();
        nav.SetCamera(new OV.Camera(new OV.Coord3D(eye.x, eye.y, eye.z), new OV.Coord3D(center.x, center.y, center.z),
            new OV.Coord3D(up.x, up.y, up.z), c.fov));
        viewer.Render();
    }
    function worldUp () { return ctx.up() === 'Z' ? V(0, 0, 1) : V(0, 1, 0); }
    function worldFront () { return ctx.up() === 'Z' ? V(0, -1, 0) : V(0, 0, 1); }
    function size () { return viewer.GetCanvasSize(); }
    function ortho () { return viewer.GetProjectionMode() === OV.ProjectionMode.Orthographic; }

    function project (p) {
        const s = size();
        const v = p.clone().project(viewer.camera);
        return { x: (v.x + 1) / 2 * s.width, y: (1 - v.y) / 2 * s.height, ok: v.z > -1 && v.z < 1 };
    }

    const raycaster = new T.Raycaster();
    function rayAt (sx, sy) {
        const s = size();
        raycaster.setFromCamera(new T.Vector2(sx / s.width * 2 - 1, -(sy / s.height) * 2 + 1), viewer.camera);
        return raycaster.ray;
    }
    // World units per screen pixel at a given point.
    function wppAt (p) {
        const v = camVecs();
        const h = size().height || 1;
        const t = Math.tan(v.fov * DEG / 2);
        if (ortho()) { return 2 * v.dist * t / h; }
        const depth = Math.max(p.clone().sub(v.eye).dot(v.fwd), modelR * 1e-4);
        return 2 * depth * t / h;
    }
    function hitAt (sx, sy) {
        if (!viewer) { return null; }
        rayAt(sx, sy);
        raycaster.params.Line = { threshold: wppAt(modelC) * 12 };
        const root = modelRoot();
        if (!root) { return null; }
        const hits = raycaster.intersectObject(root, true);
        const sec = state.section;
        for (const h of hits) {
            const o = h.object;
            if (!o.visible || !(o.isMesh || o.isLineSegments)) { continue; }
            if (sec.on && secPlane.distanceToPoint(h.point) < -modelR * 1e-6) { continue; }
            return h;
        }
        return null;
    }
    // The model itself; the engine keeps its edge outlines in a separate root.
    function modelRoot () { return viewer.mainModel.mainModel.GetRootObject(); }
    function edgeRoot () { return viewer.mainModel.edgeModel.GetRootObject(); }

    // A point under the screen position: the model if hit, else on the plane through the view centre.
    function pointUnder (sx, sy) {
        const h = hitAt(sx, sy);
        if (h) { return h.point.clone(); }
        const ray = rayAt(sx, sy);
        const v = camVecs();
        const denom = ray.direction.dot(v.fwd);
        if (Math.abs(denom) < 1e-9) { return v.center.clone(); }
        const t = v.center.clone().sub(ray.origin).dot(v.fwd) / denom;
        return ray.origin.clone().addScaledVector(ray.direction, t);
    }

    // ---------------------------------------------------------------- navigation

    function stopAnim () { if (anim) { cancelAnimationFrame(anim.raf); anim = null; } }

    function rotateAbout (v, pivot, axis, angle) {
        const q = new T.Quaternion().setFromAxisAngle(axis, angle);
        v.eye.sub(pivot).applyQuaternion(q).add(pivot);
        v.center.sub(pivot).applyQuaternion(q).add(pivot);
        v.up.applyQuaternion(q);
    }

    function orbit (dx, dy, pivot) {
        const s = size();
        const k = Math.PI / (0.9 * Math.max(240, Math.min(s.width, s.height)));
        const v = camVecs();
        const wu = worldUp();
        const flip = v.up.dot(wu) < 0 ? -1 : 1;
        rotateAbout(v, pivot, wu, -dx * k * flip);
        // Pitch around the (new) right axis, clamped so the view never rolls over a pole.
        const fwd = v.center.clone().sub(v.eye).normalize();
        const right = fwd.clone().cross(v.up).normalize();
        let th = -dy * k;
        const polar = Math.acos(Math.max(-1, Math.min(1, fwd.dot(wu))));
        const lo = 0.5 * DEG, hi = 179.5 * DEG;
        if (polar - th > hi && th < 0) { th = Math.min(0, polar - hi); }
        if (polar - th < lo && th > 0) { th = Math.max(0, polar - lo); }
        rotateAbout(v, pivot, right, th);
        setCam(v.eye, v.center, v.up);
    }

    function pan (dx, dy, at) {
        const v = camVecs();
        const w = wppAt(at || v.center);
        const d = v.right.clone().multiplyScalar(-dx * w).addScaledVector(v.sup, dy * w);
        setCam(v.eye.add(d), v.center.add(d), v.up);
    }

    function zoomAbout (p, k) {
        const v = camVecs();
        const minD = modelR * 0.002;
        const de = v.eye.clone().sub(p).length();
        if (!ortho() && de * k < minD) { k = minD / Math.max(de, 1e-12); }
        if (ortho() && v.dist * k < modelR * 0.002) { k = modelR * 0.002 / v.dist; }
        if (v.dist * k > modelR * 200) { k = modelR * 200 / v.dist; }
        const eye = p.clone().add(v.eye.clone().sub(p).multiplyScalar(k));
        const center = p.clone().add(v.center.clone().sub(p).multiplyScalar(k));
        setCam(eye, center, v.up);
    }

    function slerpDir (a, b, t, fallbackAxis) {
        const d = Math.max(-1, Math.min(1, a.dot(b)));
        const w = Math.acos(d);
        if (w < 1e-5) { return b.clone(); }
        if (Math.PI - w < 1e-3) {
            const q = new T.Quaternion().setFromAxisAngle(fallbackAxis, Math.PI * t);
            return a.clone().applyQuaternion(q);
        }
        const s = Math.sin(w);
        return a.clone().multiplyScalar(Math.sin((1 - t) * w) / s).addScaledVector(b, Math.sin(t * w) / s).normalize();
    }

    function animateTo (eye, center, up, ms) {
        stopAnim();
        const v = camVecs();
        if (!ms) { setCam(eye, center, up); return; }
        const d0 = v.eye.clone().sub(v.center), d1 = eye.clone().sub(center);
        const l0 = d0.length(), l1 = d1.length();
        const u0 = d0.normalize(), u1 = d1.normalize();
        const c0 = v.center.clone(), up0 = v.up.clone();
        const t0 = performance.now();
        const ax = worldUp();
        const step = () => {
            const t = Math.min(1, (performance.now() - t0) / ms);
            const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
            const dir = slerpDir(u0, u1, e, ax);
            const c = c0.clone().lerp(center, e);
            const len = l0 + (l1 - l0) * e;
            const u = slerpDir(up0, up, e, dir);
            setCam(c.clone().addScaledVector(dir, len), c, u);
            if (t < 1) { anim.raf = requestAnimationFrame(step); } else { anim = null; }
        };
        anim = { raf: requestAnimationFrame(step) };
    }

    // Look at the model from `dir` (from the model towards the eye), keeping the current distance.
    function viewFrom (dir, opts) {
        opts = opts || {};
        const v = camVecs();
        const d = dir.clone().normalize();
        const wu = worldUp();
        let up;
        const dot = d.dot(wu);
        if (Math.abs(dot) > 0.999) {
            up = worldFront().multiplyScalar(dot > 0 ? -1 : 1);
        } else {
            up = wu.clone().addScaledVector(d, -dot).normalize();
        }
        const center = opts.center || modelC.clone();
        const dist = opts.dist || fitDistance(modelR);
        animateTo(center.clone().addScaledVector(d, dist), center, up, opts.ms === undefined ? 380 : opts.ms);
    }

    function fitDistance (r) {
        const s = size();
        const c = cam();
        let half = c.fov / 2 * DEG;
        if (s.width < s.height) { half = Math.atan(Math.tan(half) * s.width / s.height); }
        return r / Math.sin(half) * 1.05;
    }

    function frameSphere (center, r, ms) {
        const v = camVecs();
        const dist = fitDistance(Math.max(r, modelR * 0.01));
        animateTo(center.clone().addScaledVector(v.fwd, -dist), center.clone(), v.up, ms === undefined ? 380 : ms);
    }

    function frame () {
        const f = state.tool === 'measure' ? (state.picks.length ? state.picks : null) : (state.selection ? [state.selection] : null);
        if (f) {
            const pts = [];
            for (const x of f) { featurePoints(x, pts); }
            if (pts.length) {
                const box = new T.Vector3(Infinity, Infinity, Infinity), mx = new T.Vector3(-Infinity, -Infinity, -Infinity);
                for (const p of pts) { box.min(p); mx.max(p); }
                const c = box.clone().add(mx).multiplyScalar(0.5);
                frameSphere(c, mx.distanceTo(box) / 2 * 1.4);
                return;
            }
        }
        frameSphere(modelC, modelR);
    }

    // Pointer handling. The engine's own listeners sit on the canvas; capture listeners on the stage
    // stop them so only this navigation runs.
    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'mousedown', 'wheel', 'contextmenu', 'dblclick']) {
        stage.addEventListener(type, (e) => {
            e.stopPropagation();
            if (type !== 'touchend' && type !== 'touchcancel') { e.preventDefault(); }
        }, { capture: true, passive: false });
    }

    const ptrs = new Map();
    let g = null;              // current gesture
    let lastTap = { t: 0, x: 0, y: 0 };

    function local (e) {
        const r = stage.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    function two () {
        const a = [...ptrs.values()];
        return { mid: { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2 }, dist: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) };
    }

    stage.addEventListener('pointerdown', (e) => {
        if (!viewer) { return; }
        e.preventDefault();
        stopAnim();
        try { stage.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        const p = local(e);
        ptrs.set(e.pointerId, { x: p.x, y: p.y });
        if (ptrs.size === 1) {
            const panMode = e.pointerType === 'mouse' && (e.button === 1 || e.button === 2 || e.shiftKey);
            g = { kind: panMode ? 'pan' : 'orbit', x: p.x, y: p.y, sx: p.x, sy: p.y, t: performance.now(), moved: false, pivot: null, panAt: null };
        } else if (ptrs.size === 2) {
            const t = two();
            g = { kind: 'pinch', mid: t.mid, dist: t.dist, at: pointUnder(t.mid.x, t.mid.y), moved: true };
        }
    });

    stage.addEventListener('pointermove', (e) => {
        if (!viewer || !ptrs.has(e.pointerId)) {
            if (viewer && e.pointerType === 'mouse' && !ptrs.size) { hoverAt(local(e)); }
            return;
        }
        e.preventDefault();
        const p = local(e);
        ptrs.set(e.pointerId, { x: p.x, y: p.y });
        if (!g) { return; }
        if (g.kind === 'pinch' && ptrs.size >= 2) {
            const t = two();
            if (t.dist > 1 && g.dist > 1) { zoomAbout(g.at, g.dist / t.dist); }
            pan(t.mid.x - g.mid.x, t.mid.y - g.mid.y, g.at);
            g.mid = t.mid; g.dist = t.dist;
            return;
        }
        if (ptrs.size !== 1) { return; }
        const dx = p.x - g.x, dy = p.y - g.y;
        if (!g.moved && Math.hypot(p.x - g.sx, p.y - g.sy) < 6) { return; }
        if (!g.moved) {
            g.moved = true;
            // Orbit around the point under the finger; empty space orbits the model centre.
            const h = hitAt(g.sx, g.sy);
            g.pivot = h ? h.point.clone() : modelC.clone();
            g.panAt = h ? h.point.clone() : null;
        }
        if (g.kind === 'orbit') { orbit(dx, dy, g.pivot); } else { pan(dx, dy, g.panAt); }
        g.x = p.x; g.y = p.y;
    });

    function endPointer (e) {
        if (!ptrs.has(e.pointerId)) { return; }
        const p = local(e);
        ptrs.delete(e.pointerId);
        if (!g) { return; }
        if (g.kind === 'pinch') {
            // Continue with the remaining finger without a jump, and never treat it as a tap.
            if (ptrs.size === 1) {
                const r = [...ptrs.values()][0];
                g = { kind: 'orbit', x: r.x, y: r.y, sx: r.x, sy: r.y, t: 0, moved: true, pivot: modelC.clone() };
                const h = hitAt(r.x, r.y);
                if (h) { g.pivot = h.point.clone(); }
            } else { g = null; }
            return;
        }
        if (ptrs.size === 0) {
            const wasTap = !g.moved && performance.now() - g.t < 450 && e.type === 'pointerup';
            g = null;
            if (wasTap) {
                const now = performance.now();
                if (now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) {
                    lastTap.t = 0;
                    doubleTap(p);
                } else {
                    lastTap = { t: now, x: p.x, y: p.y };
                    tap(p);
                }
            }
        }
    }
    stage.addEventListener('pointerup', endPointer);
    stage.addEventListener('pointercancel', endPointer);

    stage.addEventListener('wheel', (e) => {
        if (!viewer) { return; }
        stopAnim();
        const p = local(e);
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        if (e.ctrlKey) {   // trackpad pinch
            zoomAbout(pointUnder(p.x, p.y), Math.exp(dy * 0.01));
        } else {
            zoomAbout(pointUnder(p.x, p.y), Math.exp(dy * 0.0015));
        }
    }, { passive: true });

    function doubleTap (p) {
        const h = hitAt(p.x, p.y);
        if (!h) { frameSphere(modelC, modelR); return; }
        const v = camVecs();
        const c = h.point.clone();
        animateTo(c.clone().addScaledVector(v.fwd, -v.dist), c, v.up, 320);
    }

    // ---------------------------------------------------------------- mesh topology

    const topoCache = new WeakMap();

    function topo (mesh) {
        let t = topoCache.get(mesh);
        if (t) { return t; }
        const geo = mesh.geometry;
        const pos = geo.attributes.position;
        const idx = geo.index;
        mesh.updateMatrixWorld(true);
        const m = mesh.matrixWorld.elements;
        const q = Math.max(modelR * 2e-7, 1e-12);
        const map = new Map();
        const P = [];
        const vid = new Int32Array(pos.count);
        for (let i = 0; i < pos.count; i++) {
            const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
            const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
            const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
            const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
            const key = Math.round(wx / q) + ',' + Math.round(wy / q) + ',' + Math.round(wz / q);
            let id = map.get(key);
            if (id === undefined) { id = P.length / 3; P.push(wx, wy, wz); map.set(key, id); }
            vid[i] = id;
        }
        const nt = Math.floor((idx ? idx.count : pos.count) / 3);
        const TV = new Int32Array(nt * 3);
        for (let f = 0; f < nt; f++) {
            for (let k = 0; k < 3; k++) {
                const i = idx ? idx.getX(f * 3 + k) : f * 3 + k;
                TV[f * 3 + k] = vid[i];
            }
        }
        const Pf = new Float64Array(P);
        const N = new Float64Array(nt * 3), A = new Float64Array(nt);
        for (let f = 0; f < nt; f++) {
            const a = TV[f * 3] * 3, b = TV[f * 3 + 1] * 3, c = TV[f * 3 + 2] * 3;
            const ux = Pf[b] - Pf[a], uy = Pf[b + 1] - Pf[a + 1], uz = Pf[b + 2] - Pf[a + 2];
            const vx = Pf[c] - Pf[a], vy = Pf[c + 1] - Pf[a + 1], vz = Pf[c + 2] - Pf[a + 2];
            let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            const l = Math.hypot(nx, ny, nz);
            A[f] = l / 2;
            if (l > 0) { nx /= l; ny /= l; nz /= l; }
            N[f * 3] = nx; N[f * 3 + 1] = ny; N[f * 3 + 2] = nz;
        }
        const nv = Pf.length / 3;
        const edges = new Map();
        const nbr = new Int32Array(nt * 3).fill(-1);
        for (let f = 0; f < nt; f++) {
            for (let k = 0; k < 3; k++) {
                const a = TV[f * 3 + k], b = TV[f * 3 + (k + 1) % 3];
                if (a === b) { continue; }
                const key = a < b ? a * nv + b : b * nv + a;
                const prev = edges.get(key);
                if (prev === undefined) { edges.set(key, f * 3 + k); } else if (prev >= 0) {
                    nbr[f * 3 + k] = Math.floor(prev / 3);
                    nbr[prev] = f;
                    edges.set(key, -1);
                }
            }
        }
        t = { mesh, P: Pf, TV, N, A, nbr, nt, nv, sharpAt: null };
        topoCache.set(mesh, t);
        return t;
    }

    const cos20 = Math.cos(20 * DEG);
    function nDot (t, a, b) { return t.N[a * 3] * t.N[b * 3] + t.N[a * 3 + 1] * t.N[b * 3 + 1] + t.N[a * 3 + 2] * t.N[b * 3 + 2]; }
    function vtx (t, id) { return V(t.P[id * 3], t.P[id * 3 + 1], t.P[id * 3 + 2]); }
    function triN (t, f) { return V(t.N[f * 3], t.N[f * 3 + 1], t.N[f * 3 + 2]); }
    function centroid (t, f) {
        const a = t.TV[f * 3] * 3, b = t.TV[f * 3 + 1] * 3, c = t.TV[f * 3 + 2] * 3, P = t.P;
        return V((P[a] + P[b] + P[c]) / 3, (P[a + 1] + P[b + 1] + P[c + 1]) / 3, (P[a + 2] + P[b + 2] + P[c + 2]) / 3);
    }
    function isSharp (t, f, k) {
        const nb = t.nbr[f * 3 + k];
        if (nb < 0) { return true; }
        if (t.A[f] === 0 || t.A[nb] === 0) { return false; }
        return nDot(t, f, nb) < cos20;
    }

    function grow (t, seeds, accept, limit) {
        const seen = new Set(seeds);
        const out = seeds.slice();
        for (let i = 0; i < out.length && out.length < (limit || 2e6); i++) {
            const f = out[i];
            for (let k = 0; k < 3; k++) {
                const nb = t.nbr[f * 3 + k];
                if (nb < 0 || seen.has(nb)) { continue; }
                seen.add(nb);
                if (accept(nb, f)) { out.push(nb); }
            }
        }
        return out;
    }

    function planeRegion (t, seed) {
        const n = triN(t, seed), c = centroid(t, seed);
        const d0 = n.dot(c);
        const tol = Math.max(modelR * 2e-5, 1e-9);
        const onPlane = (f) => {
            for (let k = 0; k < 3; k++) {
                const id = t.TV[f * 3 + k];
                if (Math.abs(n.x * t.P[id * 3] + n.y * t.P[id * 3 + 1] + n.z * t.P[id * 3 + 2] - d0) > tol) { return false; }
            }
            return true;
        };
        return grow(t, [seed], (f) => (t.A[f] === 0 || nDot(t, f, seed) > 0.99995) && onPlane(f));
    }

    // A facet of a curved surface: flat only locally, every edge around it bends smoothly on.
    function allSmoothBoundary (t, region) {
        const inR = new Set(region);
        for (const f of region) {
            for (let k = 0; k < 3; k++) {
                const nb = t.nbr[f * 3 + k];
                if (nb >= 0 && inR.has(nb)) { continue; }
                if (isSharp(t, f, k)) { return false; }
            }
        }
        return true;
    }

    function distToAxis (p, c, a) {
        const w = p.clone().sub(c);
        return w.addScaledVector(a, -w.dot(a)).length();
    }

    // Direction most perpendicular to all the given normals (the axis of a cylinder).
    function nullDir (t, tris) {
        let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
        for (const f of tris) {
            const w = t.A[f];
            const x = t.N[f * 3], y = t.N[f * 3 + 1], z = t.N[f * 3 + 2];
            xx += w * x * x; xy += w * x * y; xz += w * x * z; yy += w * y * y; yz += w * y * z; zz += w * z * z;
        }
        const r0 = V(xx, xy, xz), r1 = V(xy, yy, yz), r2 = V(xz, yz, zz);
        const c = [r0.clone().cross(r1), r0.clone().cross(r2), r1.clone().cross(r2)];
        c.sort((p, q) => q.lengthSq() - p.lengthSq());
        return c[0].lengthSq() > 0 ? c[0].normalize() : null;
    }

    // Least-squares circle through the vertices of `tris`, across axis a. Returns {c, r} or null.
    function axisFit (t, tris, a) {
        const ref = Math.abs(a.x) < 0.9 ? V(1, 0, 0) : V(0, 1, 0);
        const e1 = ref.clone().addScaledVector(a, -ref.dot(a)).normalize();
        const e2 = a.clone().cross(e1);
        const ids = new Set();
        for (const f of tris) { for (let k = 0; k < 3; k++) { ids.add(t.TV[f * 3 + k]); } }
        const pts = [];
        for (const id of ids) { const p = vtx(t, id); pts.push([p.dot(e1), p.dot(e2)]); }
        const fit = circleFit2(pts);
        if (!fit || !(fit.r > 0)) { return null; }
        return { c: e1.clone().multiplyScalar(fit.cx).addScaledVector(e2, fit.cy), r: fit.r };
    }

    function tryCylinder (t, seed, plane) {
        const inP = new Set(plane);
        for (const f of plane) {
            for (let k = 0; k < 3; k++) {
                const u = t.nbr[f * 3 + k];
                if (u < 0 || inP.has(u) || t.A[u] === 0) { continue; }
                const d = nDot(t, u, seed);
                if (d > 0.99985 || d < Math.cos(50 * DEG)) { continue; }
                // Seed patch: the flat facet plus this neighbour and its neighbours that bend the same way.
                const patch = plane.concat([u]);
                let a = nullDir(t, patch);
                if (!a) { continue; }
                let fit = axisFit(t, patch, a);
                if (!fit || fit.r > modelR * 50 || fit.r < modelR * 1e-5) { continue; }
                let region = null;
                // Grow, refit on everything found, and grow again with a tighter tolerance.
                for (const tolK of [0.04, 0.015, 0.01]) {
                    const r = fit.r, c = fit.c, ax = a;
                    const tol = Math.max(r * tolK, modelR * 2e-5);
                    const ok = (g) => {
                        if (t.A[g] > 0 && Math.abs(triN(t, g).dot(ax)) > 0.035) { return false; }
                        for (let j = 0; j < 3; j++) {
                            if (Math.abs(distToAxis(vtx(t, t.TV[g * 3 + j]), c, ax) - r) > tol) { return false; }
                        }
                        return true;
                    };
                    if (!ok(seed)) { region = null; break; }
                    region = grow(t, [seed], ok);
                    if (region.length <= plane.length) { region = null; break; }
                    const a2 = nullDir(t, region);
                    if (a2) { a = a2; }
                    const f2 = axisFit(t, region, a);
                    if (!f2) { region = null; break; }
                    fit = f2;
                }
                if (!region) { continue; }
                return cylFeature(t, region, fit.c, a, seed);
            }
        }
        return null;
    }

    function cylFeature (t, region, axisP, a, seed) {
        const ids = new Set();
        for (const f of region) { for (let k = 0; k < 3; k++) { ids.add(t.TV[f * 3 + k]); } }
        // Refine the axis point by a least-squares circle fit in the plane across the axis.
        const ref = Math.abs(a.x) < 0.9 ? V(1, 0, 0) : V(0, 1, 0);
        const e1 = ref.clone().addScaledVector(a, -ref.dot(a)).normalize();
        const e2 = a.clone().cross(e1);
        const pts2 = [];
        let lo = Infinity, hi = -Infinity;
        for (const id of ids) {
            const p = vtx(t, id);
            const w = p.clone().sub(axisP);
            pts2.push([w.dot(e1), w.dot(e2)]);
            const h = p.dot(a);
            lo = Math.min(lo, h); hi = Math.max(hi, h);
        }
        const fit = circleFit2(pts2);
        let c = axisP.clone(), r;
        if (fit) {
            c = axisP.clone().addScaledVector(e1, fit.cx).addScaledVector(e2, fit.cy);
            r = fit.r;
        } else {
            r = 0; for (const id of ids) { r += distToAxis(vtx(t, id), axisP, a); } r /= ids.size;
        }
        // Angular coverage, to tell a full hole/boss from a fillet or partial arc.
        const angs = pts2.map(([x, y]) => Math.atan2(y - (fit ? fit.cy : 0), x - (fit ? fit.cx : 0))).sort((p, q) => p - q);
        let gap = 0;
        for (let i = 0; i < angs.length; i++) {
            const nx = i + 1 < angs.length ? angs[i + 1] : angs[0] + 2 * Math.PI;
            gap = Math.max(gap, nx - angs[i]);
        }
        const sweep = 2 * Math.PI - gap;
        const cs = centroid(t, seed);
        const radial = cs.clone().sub(c); radial.addScaledVector(a, -radial.dot(a));
        const hole = triN(t, seed).dot(radial) < 0;
        let area = 0; for (const f of region) { area += t.A[f]; }
        c.addScaledVector(a, -c.dot(a) + (lo + hi) / 2);   // middle of the cylinder along its axis
        return { kind: 'cyl', a, c, r, hole, len: hi - lo, sweep, area, tris: region, topo: t };
    }

    // Kasa algebraic circle fit. Returns {cx, cy, r} or null.
    function circleFit2 (pts) {
        const n = pts.length;
        if (n < 3) { return null; }
        let mx = 0, my = 0;
        for (const p of pts) { mx += p[0]; my += p[1]; }
        mx /= n; my /= n;
        let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
        for (const p of pts) {
            const u = p[0] - mx, v = p[1] - my;
            suu += u * u; svv += v * v; suv += u * v;
            suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
        }
        const det = suu * svv - suv * suv;
        if (Math.abs(det) < 1e-30) { return null; }
        const b1 = (suuu + suvv) / 2, b2 = (svvv + svuu) / 2;
        const uc = (b1 * svv - b2 * suv) / det, vc = (suu * b2 - suv * b1) / det;
        const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
        return { cx: uc + mx, cy: vc + my, r };
    }

    // Sharp edges of a mesh, by vertex, for following an edge chain.
    function sharpGraph (t) {
        if (t.sharpAt) { return t.sharpAt; }
        const at = new Map();
        const add = (a, b) => { if (!at.has(a)) { at.set(a, []); } at.get(a).push(b); };
        for (let f = 0; f < t.nt; f++) {
            if (t.A[f] === 0) { continue; }
            for (let k = 0; k < 3; k++) {
                const nb = t.nbr[f * 3 + k];
                if (nb >= 0 && nb < f) { continue; }
                if (!isSharp(t, f, k)) { continue; }
                const a = t.TV[f * 3 + k], b = t.TV[f * 3 + (k + 1) % 3];
                add(a, b); add(b, a);
            }
        }
        t.sharpAt = at;
        return at;
    }

    function edgeChain (t, a, b) {
        const at = sharpGraph(t);
        const maxTurn = Math.cos(35 * DEG);
        const walk = (prev, cur, stopAt) => {
            const out = [];
            const seen = new Set([prev, cur]);
            for (let i = 0; i < 20000; i++) {
                const nexts = at.get(cur) || [];
                const dir = vtx(t, cur).sub(vtx(t, prev)).normalize();
                let best = -1, bestDot = maxTurn;
                for (const n of nexts) {
                    if (n === prev) { continue; }
                    const d = vtx(t, n).sub(vtx(t, cur)).normalize().dot(dir);
                    if (d > bestDot) { bestDot = d; best = n; }
                }
                if (best < 0) { break; }
                if (best === stopAt) { out.push(best); return { pts: out, closed: true }; }
                if (seen.has(best)) { break; }
                seen.add(best);
                out.push(best);
                prev = cur; cur = best;
            }
            return { pts: out, closed: false };
        };
        const fwd = walk(a, b, a);
        let ids;
        let closed = fwd.closed;
        if (closed) {
            ids = [a, b].concat(fwd.pts.slice(0, -1));
        } else {
            const back = walk(b, a, b);
            ids = back.pts.reverse().concat([a, b], fwd.pts);
        }
        return { pts: ids.map((id) => vtx(t, id)), closed };
    }

    function edgeFeature (t, a, b) {
        const ch = edgeChain(t, a, b);
        const pts = ch.pts;
        const p0 = pts[0], p1 = pts[pts.length - 1];
        const len = polyLen(pts, ch.closed);
        const d = p1.clone().sub(p0);
        const L = d.length();
        if (!ch.closed && L > 0) {
            d.normalize();
            let dev = 0;
            for (const p of pts) { dev = Math.max(dev, distToAxis(p, p0, d)); }
            if (dev < Math.max(L * 1e-3, modelR * 1e-6)) { return { kind: 'line', p0, p1, len: L, pts }; }
        }
        // Circle or arc?
        if (pts.length >= 3) {
            const c0 = V(0, 0, 0); for (const p of pts) { c0.add(p); } c0.multiplyScalar(1 / pts.length);
            const n = V(0, 0, 0);
            for (let i = 0; i < pts.length; i++) {
                const p = pts[i].clone().sub(c0), q = pts[(i + 1) % pts.length].clone().sub(c0);
                n.add(p.cross(q));
            }
            if (n.length() > 1e-12) {
                n.normalize();
                let flat = 0; for (const p of pts) { flat = Math.max(flat, Math.abs(p.clone().sub(c0).dot(n))); }
                const ref = Math.abs(n.x) < 0.9 ? V(1, 0, 0) : V(0, 1, 0);
                const e1 = ref.clone().addScaledVector(n, -ref.dot(n)).normalize();
                const e2 = n.clone().cross(e1);
                const fit = circleFit2(pts.map((p) => { const w = p.clone().sub(c0); return [w.dot(e1), w.dot(e2)]; }));
                if (fit && flat < fit.r * 0.02 + modelR * 1e-6) {
                    const c = c0.clone().addScaledVector(e1, fit.cx).addScaledVector(e2, fit.cy);
                    let dev = 0; for (const p of pts) { dev = Math.max(dev, Math.abs(p.distanceTo(c) - fit.r)); }
                    if (dev < fit.r * 0.03) {
                        const sweep = ch.closed ? 2 * Math.PI : len / fit.r;
                        return { kind: 'circle', c, a: n, r: fit.r, pts, closed: ch.closed, sweep, len };
                    }
                }
            }
        }
        return { kind: 'curve', pts, len, closed: ch.closed };
    }

    function polyLen (pts, closed) {
        let l = 0;
        for (let i = 1; i < pts.length; i++) { l += pts[i].distanceTo(pts[i - 1]); }
        if (closed && pts.length > 2) { l += pts[0].distanceTo(pts[pts.length - 1]); }
        return l;
    }

    function segDist2D (p, a, b) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const L = dx * dx + dy * dy;
        let t = L > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L : 0;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
    }

    // What is under the finger: an edge (if within reach), a hole/cylinder wall, a flat face, or a point.
    function featureAt (sx, sy) {
        const h = hitAt(sx, sy);
        if (!h) { return null; }
        const pick = h.point.clone();
        const o = h.object;
        if (o.isLineSegments) {
            const pos = o.geometry.attributes.position;
            const i = h.index;
            o.updateMatrixWorld(true);
            const a = V(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(o.matrixWorld);
            const b = V(pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1)).applyMatrix4(o.matrixWorld);
            const d = b.clone().sub(a);
            const L = d.length();
            if (L > 0) {
                const s = Math.max(0, Math.min(L, pick.clone().sub(a).dot(d.normalize())));
                return { kind: 'line', p0: a, p1: b, len: L, pts: [a, b], pick: a.clone().addScaledVector(d, s) };
            }
            return { kind: 'point', p: pick, pick };
        }
        if (!o.isMesh || h.faceIndex === undefined || h.faceIndex === null) { return { kind: 'point', p: pick, pick }; }
        const t = topo(o);
        const f = h.faceIndex;
        if (f >= t.nt) { return { kind: 'point', p: pick, pick }; }
        // Edge snapping, within about a fingertip.
        const reach = 14;
        let best = null, bestD = reach;
        for (let k = 0; k < 3; k++) {
            if (!isSharp(t, f, k)) { continue; }
            const a = t.TV[f * 3 + k], b = t.TV[f * 3 + (k + 1) % 3];
            const d = segDist2D({ x: sx, y: sy }, project(vtx(t, a)), project(vtx(t, b)));
            if (d < bestD) { bestD = d; best = [a, b]; }
        }
        if (best) {
            const e = edgeFeature(t, best[0], best[1]);
            e.pick = pick;
            return e;
        }
        if (t.A[f] === 0) { return { kind: 'point', p: pick, pick }; }
        const plane = planeRegion(t, f);
        const cyl = tryCylinder(t, f, plane);
        if (cyl) { cyl.pick = pick; return cyl; }
        if (allSmoothBoundary(t, plane)) {
            // Not flat and not a cylinder: a curved face (fillet, sphere, freeform).
            const region = grow(t, [f], (g, from) => t.A[g] === 0 || nDot(t, g, from) > Math.cos(25 * DEG), 400000);
            if (region.length > plane.length) {
                let area = 0; for (const x of region) { area += t.A[x]; }
                return { kind: 'curved', area, tris: region, topo: t, pick };
            }
        }
        let area = 0; for (const x of plane) { area += t.A[x]; }
        return { kind: 'plane', n: triN(t, f), p: pick.clone(), area, tris: plane, topo: t, pick };
    }

    function featurePoints (f, out) {
        if (f.tris) {
            const t = f.topo;
            const step = Math.max(1, Math.floor(f.tris.length / 4000));
            for (let i = 0; i < f.tris.length; i += step) { for (let k = 0; k < 3; k++) { out.push(vtx(t, t.TV[f.tris[i] * 3 + k])); } }
        } else if (f.pts) { for (const p of f.pts) { out.push(p); } } else if (f.p) { out.push(f.p); }
    }

    // ---------------------------------------------------------------- measuring

    function axisOf (f) {
        if (f.kind === 'cyl' || f.kind === 'circle') { return { p: f.c, d: f.a }; }
        if (f.kind === 'line') { return { p: f.p0, d: f.p1.clone().sub(f.p0).normalize() }; }
        return null;
    }
    function refPoint (f) {
        if (f.kind === 'circle') { return f.c.clone(); }
        if (f.kind === 'cyl' || f.kind === 'line') {
            const ax = axisOf(f);
            const w = f.pick.clone().sub(ax.p);
            return ax.p.clone().addScaledVector(ax.d, w.dot(ax.d));
        }
        return f.pick.clone();
    }
    function footOnPlane (p, pl) { return p.clone().addScaledVector(pl.n, -p.clone().sub(pl.p).dot(pl.n)); }
    function footOnAxis (p, ax) { const w = p.clone().sub(ax.p); return ax.p.clone().addScaledVector(ax.d, w.dot(ax.d)); }
    function shortName (f) {
        return { plane: 'face', cyl: f.hole ? 'hole' : 'cylinder', circle: 'rim', line: 'edge', curve: 'edge', curved: 'face', point: 'point' }[f.kind];
    }

    function measure (A, B) {
        const between = A.pick.distanceTo(B.pick);
        let from = A.pick.clone(), to = B.pick.clone(), label = 'Between the clicks', angle = null, value = null, isAngle = false;
        const axA = axisOf(A), axB = axisOf(B);
        const pa = refPoint(A), pb = refPoint(B);
        if (A.kind === 'plane' && B.kind === 'plane') {
            const d = Math.abs(A.n.dot(B.n));
            if (d > 0.9998) {
                from = A.pick.clone(); to = footOnPlane(from, B);
                label = 'Face to face';
            } else {
                angle = Math.acos(Math.min(1, d)) / DEG; isAngle = true;
                label = 'Angle between faces';
            }
        } else if ((A.kind === 'plane' && axB) || (B.kind === 'plane' && axA)) {
            const pl = A.kind === 'plane' ? A : B, other = A.kind === 'plane' ? B : A;
            const ax = axisOf(other);
            const along = Math.abs(ax.d.dot(pl.n));
            const start = refPoint(other);
            if (along < 0.002 || other.kind === 'circle') {
                const f2 = start, t2 = footOnPlane(start, pl);
                if (A.kind === 'plane') { from = t2; to = f2; } else { from = f2; to = t2; }
                label = { cyl: 'Axis to face', circle: 'Centre to face', line: 'Edge to face' }[other.kind];
            } else {
                angle = Math.asin(Math.min(1, along)) / DEG; isAngle = true;
                label = other.kind === 'line' ? 'Angle between edge and face' : 'Angle between axis and face';
            }
        } else if (axA && axB) {
            const par = Math.abs(axA.d.dot(axB.d));
            if (par > 0.9998) {
                from = pa; to = footOnAxis(pa, axB);
                const kinds = [A.kind, B.kind];
                label = kinds.every((k) => k !== 'line') ? 'Centre to centre' : (kinds.every((k) => k === 'line') ? 'Edge to edge' : 'Edge to axis');
            } else if (A.kind === 'circle' && B.kind === 'circle') {
                from = A.c.clone(); to = B.c.clone(); label = 'Centre to centre';
            } else {
                angle = Math.acos(Math.min(1, par)) / DEG; isAngle = true;
                label = A.kind === 'line' && B.kind === 'line' ? 'Angle between edges' : 'Angle between axes';
            }
        } else if (A.kind === 'plane' || B.kind === 'plane') {
            const pl = A.kind === 'plane' ? A : B, other = A.kind === 'plane' ? B : A;
            const s = other.pick.clone(), f = footOnPlane(s, pl);
            if (A.kind === 'plane') { from = f; to = s; } else { from = s; to = f; }
            label = 'Point to face';
        } else if (axA || axB) {
            const ax = axA || axB, other = axA ? B : A;
            const s = other.pick.clone(), f = footOnAxis(s, ax);
            if (axA) { from = f; to = s; } else { from = s; to = f; }
            label = (axA ? A : B).kind === 'line' ? 'Point to edge' : 'Point to centre line';
        } else {
            from = pa; to = pb; label = 'Point to point';
        }
        value = from.distanceTo(to);
        return { value, from, to, label, angle, isAngle, between, delta: to.clone().sub(from) };
    }

    // ---------------------------------------------------------------- section

    const secPlane = new T.Plane(V(0, -1, 0), 0);
    let secGroup = null, secCap = null, secBuilt = false;
    let bounds = null;

    function axisVec (a) { return a === 'x' ? V(1, 0, 0) : a === 'y' ? V(0, 1, 0) : V(0, 0, 1); }

    function eachMaterial (fn) {
        if (!viewer) { return; }
        for (const root of [modelRoot(), edgeRoot()]) {
            if (!root) { continue; }
            root.traverse((o) => {
                if (!o.material) { return; }
                const ms = Array.isArray(o.material) ? o.material : [o.material];
                for (const m of ms) { fn(m, o); }
            });
        }
        if (overlay) { overlay.traverse((o) => { if (o.material) { fn(o.material, o); } }); }
    }

    function applyClip () {
        const on = state.section.on;
        viewer.renderer.localClippingEnabled = true;
        eachMaterial((m) => {
            const has = !!(m.clippingPlanes && m.clippingPlanes.length && m.clippingPlanes[0] === secPlane);
            if (has !== on) { m.clippingPlanes = on ? [secPlane] : null; m.needsUpdate = true; }
        });
    }

    function buildSection () {
        if (secBuilt) { return; }
        secBuilt = true;
        secGroup = new T.Group();
        secGroup.name = 'cs-section';
        const base = { colorWrite: false, depthWrite: false, depthTest: false, stencilWrite: true, stencilFunc: T.AlwaysStencilFunc, clippingPlanes: [secPlane] };
        const back = new T.MeshBasicMaterial(Object.assign({ side: T.BackSide, stencilFail: T.IncrementWrapStencilOp, stencilZFail: T.IncrementWrapStencilOp, stencilZPass: T.IncrementWrapStencilOp }, base));
        const front = new T.MeshBasicMaterial(Object.assign({ side: T.FrontSide, stencilFail: T.DecrementWrapStencilOp, stencilZFail: T.DecrementWrapStencilOp, stencilZPass: T.DecrementWrapStencilOp }, base));
        modelRoot().traverse((o) => {
            if (!o.isMesh) { return; }
            o.updateMatrixWorld(true);
            for (const m of [back, front]) {
                const h = new T.Mesh(o.geometry, m);
                h.matrixAutoUpdate = false;
                h.matrix.copy(o.matrixWorld);
                h.matrixWorld.copy(o.matrixWorld);
                h.renderOrder = 1;
                h.raycast = () => {};
                secGroup.add(h);
            }
        });
        const capMat = new T.ShaderMaterial({
            uniforms: { uScale: { value: window.devicePixelRatio || 1 } },
            vertexShader: 'void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
            fragmentShader: 'uniform float uScale;void main(){float s=mod(gl_FragCoord.x+gl_FragCoord.y,9.0*uScale);' +
                'vec3 base=vec3(0.50,0.53,0.58);vec3 ln=vec3(0.20,0.22,0.26);gl_FragColor=vec4(s<1.6*uScale?ln:base,1.0);}',
            side: T.DoubleSide,
            stencilWrite: true, stencilRef: 0, stencilFunc: T.NotEqualStencilFunc,
            stencilFail: T.ReplaceStencilOp, stencilZFail: T.ReplaceStencilOp, stencilZPass: T.ReplaceStencilOp
        });
        secCap = new T.Mesh(new T.PlaneGeometry(1, 1), capMat);
        secCap.renderOrder = 2;
        secCap.raycast = () => {};
        secGroup.add(secCap);
        viewer.scene.add(secGroup);
    }

    function updateSection () {
        const s = state.section;
        if (!viewer) { return; }
        if (s.on) { buildSection(); }
        if (secGroup) { secGroup.visible = s.on; }
        applyClip();
        if (s.on && bounds) {
            const e = axisVec(s.axis);
            const lo = bounds.min[s.axis], hi = bounds.max[s.axis];
            const v = lo + (hi - lo) * s.t;
            const n = e.clone().multiplyScalar(s.flip ? 1 : -1);
            secPlane.normal.copy(n);
            secPlane.constant = s.flip ? -v : v;
            const c = modelC.clone();
            c[s.axis] = v;
            secCap.position.copy(c);
            secCap.quaternion.setFromUnitVectors(V(0, 0, 1), n);
            secCap.scale.set(modelR * 5, modelR * 5, 1);
            secCap.updateMatrixWorld(true);
            $('secVal').textContent = s.axis.toUpperCase() + ' = ' + fmtLen(v);
        }
        $('secBar').classList.toggle('on', s.on);
        for (const b of document.querySelectorAll('#secBar .ax[data-axis]')) { b.setAttribute('aria-pressed', String(b.dataset.axis === s.axis)); }
        $('secFlip').setAttribute('aria-pressed', String(s.flip));
        setPressed('section', s.on);
        viewer.Render();
    }

    // ---------------------------------------------------------------- highlights and dimensions

    const hlMat = () => new T.MeshBasicMaterial({ color: 0x3d7bff, transparent: true, opacity: 0.6, side: T.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, depthWrite: false,
        clippingPlanes: state.section.on ? [secPlane] : null });

    function clearOverlay () {
        if (!overlay) { return; }
        for (const c of overlay.children.slice()) {
            overlay.remove(c);
            if (c.geometry) { c.geometry.dispose(); }
            if (c.material) { c.material.dispose(); }
        }
    }

    function addFaceHighlight (f) {
        if (!f.tris || !overlay) { return; }
        const t = f.topo;
        const arr = new Float32Array(f.tris.length * 9);
        let i = 0;
        for (const tri of f.tris) {
            for (let k = 0; k < 3; k++) {
                const id = t.TV[tri * 3 + k] * 3;
                arr[i++] = t.P[id]; arr[i++] = t.P[id + 1]; arr[i++] = t.P[id + 2];
            }
        }
        const geo = new T.BufferGeometry();
        geo.setAttribute('position', new T.BufferAttribute(arr, 3));
        const m = new T.Mesh(geo, hlMat());
        m.renderOrder = 3;
        m.raycast = () => {};
        overlay.add(m);
    }

    function refreshHighlights () {
        clearOverlay();
        const fs = state.tool === 'measure' ? state.picks : (state.selection ? [state.selection] : []);
        for (const f of fs) { addFaceHighlight(f); }
        drawDims();
        viewer.Render();
    }

    function svg (tag, attrs, parent) {
        const e = document.createElementNS(SVGNS, tag);
        for (const k in attrs) { e.setAttribute(k, attrs[k]); }
        (parent || dims).appendChild(e);
        return e;
    }

    function drawPoly (pts, cls, closed) {
        const s = pts.map(project);
        if (s.some((p) => !p.ok)) { return; }
        svg(closed ? 'polygon' : 'polyline', { points: s.map((p) => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' '), class: cls });
    }

    function drawFeature (f) {
        if (f.kind === 'line' || f.kind === 'curve') { drawPoly(f.pts, 'hl', f.closed); }
        if (f.kind === 'circle') { drawPoly(f.pts, 'hl', f.closed); dot(f.c); }
        if (f.kind === 'cyl') {
            const h = f.len / 2 + modelR * 0.04;
            drawPoly([f.c.clone().addScaledVector(f.a, -h), f.c.clone().addScaledVector(f.a, h)], 'ax');
        }
        if (f.kind === 'point') { dot(f.p); }
    }
    function dot (p) { const s = project(p); if (s.ok) { svg('circle', { cx: s.x, cy: s.y, r: 4, class: 'pt' }); } }

    function label (x, y, text) {
        const g = svg('g', { class: 'lab' });
        const tx = svg('text', { x: 0, y: 0, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, g);
        tx.textContent = text;
        const w = text.length * 7.3 + 12;
        const r = svg('rect', { x: -w / 2, y: -10, width: w, height: 20, rx: 5 }, g);
        g.insertBefore(r, tx);
        g.setAttribute('transform', 'translate(' + x.toFixed(1) + ',' + y.toFixed(1) + ')');
    }

    function drawDim (m) {
        const a = project(m.from), b = project(m.to);
        if (!a.ok || !b.ok) { return; }
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (m.isAngle) {
            svg('line', { x1: project(state.picks[0].pick).x, y1: project(state.picks[0].pick).y, x2: project(state.picks[1].pick).x, y2: project(state.picks[1].pick).y, class: 'dx' });
            const p = project(state.picks[0].pick.clone().lerp(state.picks[1].pick, 0.5));
            label(p.x, p.y, m.angle.toFixed(2) + '°');
            return;
        }
        if (len > 1) {
            svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'dl' });
            const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
            const head = (p, sx) => {
                const L = 9, W = 4;
                const bx = p.x - ux * L * sx, by = p.y - uy * L * sx;
                svg('polygon', { points: [p.x, p.y, bx - uy * W, by + ux * W, bx + uy * W, by - ux * W].map((n) => n.toFixed(1)).join(','), class: 'ah' });
            };
            if (len > 26) { head(b, 1); head(a, -1); }
        }
        svg('circle', { cx: a.x, cy: a.y, r: 3.5, class: 'pt' });
        svg('circle', { cx: b.x, cy: b.y, r: 3.5, class: 'pt' });
        label((a.x + b.x) / 2, (a.y + b.y) / 2 - 2, fmtLen(m.value, true));
    }

    function drawDims () {
        while (dims.firstChild) { dims.removeChild(dims.firstChild); }
        if (!viewer) { return; }
        if (state.tool === 'measure') {
            for (const f of state.picks) { drawFeature(f); }
            if (state.picks.length === 2) { drawDim(measure(state.picks[0], state.picks[1])); } else if (state.picks.length === 1) { dot(state.picks[0].pick); }
        } else if (state.selection) {
            drawFeature(state.selection);
        }
    }

    // ---------------------------------------------------------------- formatting and the card

    function unit () { return (ctx && ctx.unit()) || ''; }
    function dec () { const u = unit(); return u === 'm' ? 4 : (u === 'cm' || u === 'in' || u === 'ft') ? 3 : 2; }
    function fmtNum (x) { return (Math.abs(x) < 5e-10 ? 0 : x).toFixed(dec()); }
    function fmtLen (x, withUnit) { const u = unit(); return fmtNum(x) + (u && withUnit !== false ? ' ' + u : ''); }
    function esc (s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    function big (v, u) { return '<div class="big">' + esc(v) + (u ? '<small>' + esc(u) + '</small>' : '') + '</div>'; }
    function axisName (n) {
        const ax = ['X', 'Y', 'Z'], c = [n.x, n.y, n.z];
        for (let i = 0; i < 3; i++) { if (Math.abs(c[i]) > 0.9999) { return (c[i] > 0 ? '+' : '−') + ax[i]; } }
        return '(' + c.map((x) => x.toFixed(3)).join(', ') + ')';
    }

    function describe (f) {
        const u = unit();
        const area = (a) => big(fmtNum(a), u ? u + '²' : 'units²');
        switch (f.kind) {
        case 'plane':
            return { k: 'Flat face', html: area(f.area), sub: 'Normal ' + axisName(f.n) };
        case 'cyl':
            if (f.sweep < 300 * DEG) {
                return { k: f.hole ? 'Concave arc face (fillet or slot end)' : 'Convex arc face (round)', html: big('R ' + fmtNum(f.r), u),
                    sub: 'Ø ' + fmtLen(2 * f.r) + ' · ' + (f.sweep / DEG).toFixed(0) + '° of arc · length ' + fmtLen(f.len) };
            }
            return { k: f.hole ? 'Hole' : 'Cylinder', html: big('Ø ' + fmtNum(2 * f.r), u),
                sub: (f.hole ? 'Depth ' : 'Length ') + fmtLen(f.len) + ' · axis ' + axisName(f.a) };
        case 'circle':
            return { k: f.closed ? 'Circular edge' : 'Arc edge', html: big((f.closed ? 'Ø ' + fmtNum(2 * f.r) : 'R ' + fmtNum(f.r)), u),
                sub: (f.closed ? 'Radius ' + fmtLen(f.r) : (f.sweep / DEG).toFixed(0) + '° arc · length ' + fmtLen(f.len)) + ' · axis ' + axisName(f.a) };
        case 'line':
            return { k: 'Straight edge', html: big(fmtNum(f.len), u), sub: 'Direction ' + axisName(f.p1.clone().sub(f.p0).normalize()) };
        case 'curve':
            return { k: 'Edge', html: big(fmtNum(f.len), u), sub: 'Length along the edge' };
        case 'curved':
            return { k: 'Curved face', html: area(f.area), sub: 'Surface area' };
        default:
            return { k: 'Point', html: big(fmtNum(f.p.x) + ', ' + fmtNum(f.p.y) + ', ' + fmtNum(f.p.z), ''), sub: 'X, Y, Z' + (u ? ' in ' + u : '') };
        }
    }

    function renderCard () {
        const card = $('card');
        let html = '';
        if (state.tool === 'measure' && state.picks.length === 2) {
            const m = measure(state.picks[0], state.picks[1]);
            const u = unit();
            if (m.isAngle) {
                html = '<div class="k">' + esc(m.label) + '</div>' + big(m.angle.toFixed(2) + '°', '');
            } else {
                html = '<div class="k">Measure</div>' + big(fmtNum(m.value), u) + '<div class="sub">' + esc(m.label) + '</div>';
                html += '<div class="grid"><div><span>ΔX</span><b>' + fmtNum(Math.abs(m.delta.x)) + '</b></div><div><span>ΔY</span><b>' +
                    fmtNum(Math.abs(m.delta.y)) + '</b></div><div><span>ΔZ</span><b>' + fmtNum(Math.abs(m.delta.z)) + '</b></div></div>';
            }
            html += '<div class="row"><span>Between the clicks</span><b>' + esc(fmtLen(m.between)) + '</b></div>';
            const a = describe(state.picks[0]), b = describe(state.picks[1]);
            html += '<div class="row"><span>1 · ' + esc(a.k) + '</span><b>' + esc(stripTags(a.html)) + '</b></div>';
            html += '<div class="row"><span>2 · ' + esc(b.k) + '</span><b>' + esc(stripTags(b.html)) + '</b></div>';
        } else {
            const f = state.tool === 'measure' ? state.picks[0] : state.selection;
            if (f) {
                const d = describe(f);
                html = '<div class="k">' + esc(d.k) + (state.tool === 'measure' ? ' · tap a second feature' : '') + '</div>' + d.html + '<div class="sub">' + esc(d.sub) + '</div>';
            }
        }
        if (html) {
            html += '<button class="iconBtn x" id="cardClose" aria-label="Clear"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';
        }
        card.innerHTML = html;
        card.classList.toggle('on', !!html);
        const x = $('cardClose');
        if (x) { x.addEventListener('click', clearSelection); }
    }
    function stripTags (h) {
        const d = document.createElement('div');
        d.innerHTML = h.replace(/<small>/g, '<small> ');
        return d.textContent.replace(/\s+/g, ' ').trim();
    }

    function clearSelection () {
        state.selection = null;
        state.picks = [];
        renderCard();
        refreshHighlights();
    }

    function tap (p) {
        if (!viewer) { return; }
        const f = featureAt(p.x, p.y);
        if (state.tool === 'measure') {
            if (!f) { if (state.picks.length === 2) { state.picks = []; } } else {
                if (state.picks.length >= 2) { state.picks = []; }
                state.picks.push(f);
                ctx.post({ type: 'haptic' });
            }
        } else {
            state.selection = f;
            if (f) { ctx.post({ type: 'haptic' }); }
        }
        renderCard();
        refreshHighlights();
    }

    // ---------------------------------------------------------------- hint, toolbar

    let hintTimer = 0;
    function hint (text, ms) {
        clearTimeout(hintTimer);
        $('hint').textContent = text || '';
        if (text) { hintTimer = setTimeout(() => { $('hint').textContent = ''; }, ms || 4500); }
    }
    function setPressed (tool, on) {
        const b = document.querySelector('#toolbar [data-tool="' + tool + '"]');
        if (b) { b.setAttribute('aria-pressed', String(on)); }
    }
    function setTool (tool) {
        state.tool = tool;
        setPressed('inspect', tool === 'inspect');
        setPressed('measure', tool === 'measure');
        hint(tool === 'measure'
            ? 'Tap a hole, edge or face, then a second one. Walls measure from the axis, rims from the centre.'
            : 'Tap a face or edge to see its size. Double tap to centre on a point.');
        renderCard();
        refreshHighlights();
    }

    for (const b of document.querySelectorAll('#toolbar button')) {
        b.addEventListener('click', () => {
            if (!viewer) { return; }
            const t = b.dataset.tool;
            if (t === 'frame') { frame(); return; }
            if (t === 'section') {
                state.section.on = !state.section.on;
                if (state.section.on) { hint('Drag the slider to move the cut. Cut faces show hatched.'); }
                updateSection();
                return;
            }
            setTool(t);
        });
    }
    for (const b of document.querySelectorAll('#secBar .ax[data-axis]')) {
        b.addEventListener('click', () => { state.section.axis = b.dataset.axis; updateSection(); });
    }
    $('secFlip').addEventListener('click', () => { state.section.flip = !state.section.flip; updateSection(); });
    $('secSlider').addEventListener('input', (e) => { state.section.t = Number(e.target.value) / 1000; updateSection(); });
    $('homeBtn').addEventListener('click', () => { if (viewer) { home(true); } });

    window.addEventListener('keydown', (e) => {
        if (!viewer || e.metaKey || e.ctrlKey) { return; }
        const k = e.key.toLowerCase();
        if (k === 's') { setTool('inspect'); } else if (k === 'm') { setTool('measure'); } else if (k === 'f') { frame(); } else if (k === 'x') {
            state.section.on = !state.section.on; updateSection();
        } else if (k === 'escape') { clearSelection(); }
    });

    function home (animate) {
        const wu = worldUp(), fr = worldFront();
        const right = fr.clone().cross(wu).multiplyScalar(-1);   // +X
        viewFrom(fr.clone().add(right).normalize().add(wu.clone().multiplyScalar(0.75)), { ms: animate ? 420 : 0 });
    }

    // ---------------------------------------------------------------- view cube and triad

    const cubeRot = $('cubeRot');
    const FACE = 46, H = FACE / 2;
    let cubeFaces = [];

    function dirName (d) {
        const parts = [];
        const zUp = ctx.up() === 'Z';
        const up = zUp ? d.z : d.y;
        const front = zUp ? -d.y : d.z;
        if (up > 0.5) { parts.push('Top'); } else if (up < -0.5) { parts.push('Bottom'); }
        if (front > 0.5) { parts.push('front'); } else if (front < -0.5) { parts.push('back'); }
        if (d.x > 0.5) { parts.push('right'); } else if (d.x < -0.5) { parts.push('left'); }
        const s = parts.join(' ');
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    function buildCube () {
        cubeRot.innerHTML = '';
        cubeFaces = [];
        const wu = worldUp(), fr = worldFront();
        const axes = [V(1, 0, 0), V(-1, 0, 0), V(0, 1, 0), V(0, -1, 0), V(0, 0, 1), V(0, 0, -1)];
        for (const n of axes) {
            let u;
            if (Math.abs(n.dot(wu)) > 0.9) { u = wu.clone().cross(fr); } else { u = wu.clone().cross(n); }
            u.normalize();
            const d = n.clone().cross(u).multiplyScalar(-1);
            const tr = n.clone().multiplyScalar(H).addScaledVector(u, -H).addScaledVector(d, -H);
            const el = document.createElement('div');
            el.className = 'face';
            el.style.width = el.style.height = FACE + 'px';
            el.style.transform = 'matrix3d(' + [u.x, u.y, u.z, 0, d.x, d.y, d.z, 0, n.x, n.y, n.z, 0, tr.x, tr.y, tr.z, 1].map((x) => +x.toFixed(6)).join(',') + ')';
            for (let j = 0; j < 3; j++) {
                for (let i = 0; i < 3; i++) {
                    const cell = document.createElement('i');
                    const dir = n.clone().addScaledVector(u, i - 1).addScaledVector(d, j - 1).normalize();
                    cell.dataset.dir = [dir.x, dir.y, dir.z].join(',');
                    cell.title = dirName(dir);
                    el.appendChild(cell);
                }
            }
            const lbl = document.createElement('span');
            lbl.className = 'lbl';
            lbl.textContent = dirName(n).toUpperCase();
            el.appendChild(lbl);
            cubeRot.appendChild(el);
            cubeFaces.push({ el, n });
        }
    }

    function updateCube () {
        const v = camVecs();
        const r = v.right, u = v.sup, b = v.fwd.clone().multiplyScalar(-1);
        cubeRot.style.transform = 'matrix3d(' + [r.x, -u.x, b.x, 0, r.y, -u.y, b.y, 0, r.z, -u.z, b.z, 0, 0, 0, 0, 1].map((x) => +x.toFixed(6)).join(',') + ')';
        for (const f of cubeFaces) { f.el.style.visibility = f.n.dot(b) > 0.01 ? 'visible' : 'hidden'; }
        // Triad
        const tri = $('triad');
        const ax = [{ d: V(1, 0, 0), c: '#ff6161', n: 'X' }, { d: V(0, 1, 0), c: '#5fd068', n: 'Y' }, { d: V(0, 0, 1), c: '#5a95ff', n: 'Z' }];
        ax.sort((p, q) => p.d.dot(b) - q.d.dot(b));
        let s = '';
        for (const a of ax) {
            const x = a.d.dot(r) * 20, y = -a.d.dot(u) * 20;
            s += '<line x1="0" y1="0" x2="' + x.toFixed(1) + '" y2="' + y.toFixed(1) + '" stroke="' + a.c + '" stroke-width="2.2" stroke-linecap="round"/>';
            s += '<text x="' + (x * 1.32).toFixed(1) + '" y="' + (y * 1.32 + 3.5).toFixed(1) + '" fill="' + a.c + '" text-anchor="middle">' + a.n + '</text>';
        }
        tri.innerHTML = s;
    }

    // Cube: tap a face, edge or corner; drag on it to orbit.
    let cubeDrag = null, tipTimer = 0;
    const cubeEl = $('cube');
    function showTip (text) {
        const tip = $('tip');
        tip.textContent = text;
        tip.classList.add('on');
        clearTimeout(tipTimer);
        tipTimer = setTimeout(() => tip.classList.remove('on'), 1100);
    }
    function cellAt (e) {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        return el && el.dataset && el.dataset.dir ? el : null;
    }
    let hot = null;
    function setHot (c) { if (hot) { hot.classList.remove('hot'); } hot = c; if (hot) { hot.classList.add('hot'); } }
    cubeEl.addEventListener('pointerdown', (e) => {
        if (!viewer) { return; }
        e.preventDefault();
        stopAnim();
        try { cubeEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        cubeDrag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, cell: cellAt(e) };
        setHot(cubeDrag.cell);
    });
    cubeEl.addEventListener('pointermove', (e) => {
        if (!cubeDrag) {
            if (e.pointerType === 'mouse') { const c = cellAt(e); setHot(c); if (c) { showTip(c.title); } }
            return;
        }
        if (!cubeDrag.moved && Math.hypot(e.clientX - cubeDrag.sx, e.clientY - cubeDrag.sy) < 5) { return; }
        cubeDrag.moved = true;
        setHot(null);
        orbit((e.clientX - cubeDrag.x) * 1.6, (e.clientY - cubeDrag.y) * 1.6, modelC.clone());
        cubeDrag.x = e.clientX; cubeDrag.y = e.clientY;
    });
    const cubeUp = (e) => {
        if (!cubeDrag) { return; }
        const d = cubeDrag;
        cubeDrag = null;
        if (!d.moved && d.cell && e.type === 'pointerup') {
            const p = d.cell.dataset.dir.split(',').map(Number);
            showTip(d.cell.title);
            viewFrom(V(p[0], p[1], p[2]), { center: modelC.clone(), dist: fitDistance(modelR) });
            ctx.post({ type: 'haptic' });
        }
        setTimeout(() => setHot(null), 160);
    };
    cubeEl.addEventListener('pointerup', cubeUp);
    cubeEl.addEventListener('pointercancel', cubeUp);
    cubeEl.addEventListener('pointerleave', () => { if (!cubeDrag) { setHot(null); } });

    function hoverAt () { /* reserved for mouse hover highlighting */ }

    // ---------------------------------------------------------------- lifecycle

    function afterRender () {
        if (!viewer) { return; }
        updateCube();
        drawDims();
    }

    function attach (embedded, context) {
        detach();
        emb = embedded;
        viewer = embedded.GetViewer();
        nav = viewer.navigation;
        ctx = context;
        const s = viewer.GetBoundingSphere(() => true);
        if (s) { modelC = fromC(s.center); modelR = Math.max(s.radius, 1e-9); }
        const bb = viewer.GetBoundingBox(() => true);
        bounds = bb ? { min: { x: bb.min.x, y: bb.min.y, z: bb.min.z }, max: { x: bb.max.x, y: bb.max.y, z: bb.max.z } } : null;
        overlay = new T.Group();
        overlay.name = 'cs-overlay';
        viewer.scene.add(overlay);
        const orig = viewer.Render.bind(viewer);
        viewer.Render = function () { orig(); afterRender(); };
        renderHooked = true;
        state.selection = null;
        state.picks = [];
        state.section = { on: false, axis: ctx.up() === 'Z' ? 'z' : 'y', t: 0.5, flip: false };
        $('secSlider').value = '500';
        buildCube();
        ui.classList.add('on');
        const hasMesh = (() => { let m = false; const r = modelRoot(); if (r) { r.traverse((o) => { if (o.isMesh) { m = true; } }); } return m; })();
        setPressed('section', false);
        document.querySelector('#toolbar [data-tool="section"]').style.display = hasMesh ? '' : 'none';
        renderCard();
        setTool('inspect');
        updateCube();
    }

    function detach () {
        stopAnim();
        if (viewer && overlay) { clearOverlay(); viewer.scene.remove(overlay); }
        if (viewer && secGroup) { viewer.scene.remove(secGroup); }
        overlay = null; secGroup = null; secCap = null; secBuilt = false;
        viewer = null; nav = null; emb = null; renderHooked = false;
        ptrs.clear(); g = null;
        while (dims.firstChild) { dims.removeChild(dims.firstChild); }
        ui.classList.remove('on');
    }

    window.CSTools = {
        attach,
        detach,
        home: () => home(false),
        // Named views for the native app: front, back, left, right, top, bottom, iso.
        view: (name, animate) => {
            if (!viewer) { return; }
            const wu = worldUp(), fr = worldFront(), rt = fr.clone().cross(wu).multiplyScalar(-1);
            const m = { front: fr, back: fr.clone().negate(), right: rt, left: rt.clone().negate(), top: wu, bottom: wu.clone().negate() };
            if (name === 'iso' || !m[name]) { home(animate); } else { viewFrom(m[name], { ms: animate ? 380 : 0 }); }
        },
        frame,
        upChanged: () => { if (viewer) { buildCube(); updateCube(); } },
        refresh: () => { if (viewer) { applyClip(); viewer.Render(); } },
        recenter: () => {
            if (!viewer) { return; }
            const s = viewer.GetBoundingSphere(() => true);
            if (s) { modelC = fromC(s.center); modelR = Math.max(s.radius, 1e-9); }
        },
        // For tests.
        _featureAt: (x, y) => featureAt(x, y),
        _measure: measure,
        _state: state,
        _tap: (x, y) => tap({ x, y })
    };
})();
