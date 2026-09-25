import {
	AdditiveBlending,
	BoxGeometry,
	BufferAttribute,
	BufferGeometry,
	type Color,
	EdgesGeometry,
	Group,
	IcosahedronGeometry,
	LineBasicMaterial,
	LineSegments,
	Mesh,
	OctahedronGeometry,
	Points,
	PointsMaterial,
	ShaderMaterial,
	SphereGeometry,
	TorusGeometry,
	MeshBasicMaterial,
	type Material,
} from "three";
import type { Vibr } from "../model";
import { type StagePalette, VIBR_STYLES, type VibrStyle } from "./palette";

// Ashima Arts 3D simplex noise (MIT) — the one noise every displaced body uses.
const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.0-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;vec4 s1=floor(b1)*2.0+1.0;vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

const VERTEX = /* glsl */ `
${NOISE}
uniform float uTime; uniform float uAmp; uniform float uFreq; uniform float uSpeed; uniform float uEnergy;
varying vec3 vNormal; varying vec3 vView; varying float vNoise;
void main(){
  float n = snoise(normal * uFreq + vec3(uTime * uSpeed));
  float breath = 1.0 + 0.035 * sin(uTime * (1.2 + uEnergy * 3.0));
  vec3 displaced = position * breath + normal * n * uAmp * (0.7 + uEnergy * 0.6);
  vNoise = n;
  vec4 mv = modelViewMatrix * vec4(displaced, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const FRAGMENT = /* glsl */ `
uniform vec3 uHueA; uniform vec3 uHueB; uniform float uEnergy; uniform float uTime;
varying vec3 vNormal; varying vec3 vView; varying float vNoise;
void main(){
  float fres = pow(1.0 - max(dot(vNormal, vView), 0.0), 2.4);
  vec3 body = mix(uHueA, uHueB, smoothstep(-0.6, 0.8, vNoise));
  float veins = smoothstep(0.55, 0.9, abs(sin(vNoise * 6.0 + uTime * 0.6)));
  vec3 color = body * (0.18 + 0.2 * uEnergy) + body * veins * 0.24 + mix(uHueB, vec3(1.0), 0.15) * fres * (0.32 + uEnergy * 0.5);
  gl_FragColor = vec4(color, 1.0);
}`;

function shapeGeometry(style: VibrStyle): BufferGeometry {
	switch (style.shape) {
		case "sphere":
			return new SphereGeometry(1, 96, 96);
		case "icosa":
			return new IcosahedronGeometry(1.05, 3);
		case "box":
			return new BoxGeometry(1.35, 1.35, 1.35, 24, 24, 24);
		case "octa":
			return new OctahedronGeometry(1.15, 3);
	}
}

/** A deterministic point cloud — seeded so a vibr never "reshuffles" on redraw. */
function seededCloud(count: number, inner: number, outer: number, flat: number, seed: number): BufferGeometry {
	let s = seed;
	const rand = () => {
		s = (s * 16807) % 2147483647;
		return (s - 1) / 2147483646;
	};
	const positions = new Float32Array(count * 3);
	for (let i = 0; i < count; i++) {
		const theta = rand() * Math.PI * 2;
		const phi = Math.acos(2 * rand() - 1);
		const r = inner + (outer - inner) * Math.pow(rand(), 0.7);
		positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
		positions[i * 3 + 1] = r * Math.cos(phi) * flat;
		positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
	}
	const geometry = new BufferGeometry();
	geometry.setAttribute("position", new BufferAttribute(positions, 3));
	return geometry;
}

export interface AgentCore {
	readonly group: Group;
	/** The mesh a pointer ray should hit to mean "the core". */
	readonly hit: Mesh;
	/** 0…1 — how hard the mind is working (thinking level). */
	setEnergy(energy: number): void;
	tick(time: number, dt: number): void;
	dispose(): void;
}

/**
 * One agent's body. Every vibr is the same machine with different settings:
 * a displaced shader surface, an optional wire skeleton, one signature extra.
 */
export function createCore(vibr: Vibr, palette: StagePalette, scale = 1): AgentCore {
	const style = VIBR_STYLES[vibr];
	const hueA = palette[style.hues[0]] as Color;
	const hueB = palette[style.hues[1]] as Color;
	const group = new Group();
	const materials: Material[] = [];
	const geometries: BufferGeometry[] = [];
	const spinners: { object: Group | Points | Mesh | LineSegments; axis: "x" | "y" | "z"; rate: number }[] = [];

	const uniforms = {
		uTime: { value: 0 },
		uAmp: { value: style.amp },
		uFreq: { value: style.freq },
		uSpeed: { value: style.speed },
		uEnergy: { value: 0.35 },
		uHueA: { value: hueA.clone() },
		uHueB: { value: hueB.clone() },
	};
	const bodyGeometry = shapeGeometry(style);
	const bodyMaterial = new ShaderMaterial({ uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT });
	const body = new Mesh(bodyGeometry, bodyMaterial);
	geometries.push(bodyGeometry);
	materials.push(bodyMaterial);
	group.add(body);
	spinners.push({ object: body, axis: "y", rate: 0.12 });

	if (style.wire) {
		const edges = new EdgesGeometry(bodyGeometry.type === "BoxGeometry" ? new BoxGeometry(1.5, 1.5, 1.5) : new IcosahedronGeometry(1.32, 1));
		const wireMaterial = new LineBasicMaterial({ color: hueB, transparent: true, opacity: 0.55, blending: AdditiveBlending, depthWrite: false });
		const wire = new LineSegments(edges, wireMaterial);
		geometries.push(edges);
		materials.push(wireMaterial);
		group.add(wire);
		spinners.push({ object: wire, axis: "y", rate: -0.18 });
	}

	const addPoints = (geometry: BufferGeometry, color: Color, size: number, opacity: number, axis: "x" | "y" | "z", rate: number) => {
		const material = new PointsMaterial({ color, size, transparent: true, opacity, blending: AdditiveBlending, depthWrite: false, sizeAttenuation: true });
		const points = new Points(geometry, material);
		geometries.push(geometry);
		materials.push(material);
		group.add(points);
		spinners.push({ object: points, axis, rate });
		return points;
	};

	switch (style.extra) {
		case "cloud":
			addPoints(seededCloud(900, 1.25, 2.1, 1, 7), hueA, 0.035, 0.75, "y", 0.22);
			break;
		case "disk": {
			addPoints(seededCloud(1400, 1.4, 2.6, 0.06, 11), hueA, 0.03, 0.8, "y", 0.55);
			const jetGeometry = seededCloud(260, 0.1, 0.25, 1, 5);
			const positions = jetGeometry.getAttribute("position") as BufferAttribute;
			for (let i = 0; i < positions.count; i++) positions.setY(i, (i % 2 === 0 ? 1 : -1) * (1.2 + (i / positions.count) * 2.2));
			addPoints(jetGeometry, hueB, 0.05, 0.7, "y", 1.2);
			break;
		}
		case "bands":
			for (let i = 0; i < 3; i++) {
				const geometry = new TorusGeometry(1.45 + i * 0.12, 0.012, 8, 160);
				const material = new MeshBasicMaterial({ color: i === 1 ? hueB : hueA, transparent: true, opacity: 0.8, blending: AdditiveBlending, depthWrite: false });
				const band = new Mesh(geometry, material);
				band.rotation.set(0.9 + i * 0.7, i * 1.1, 0.3 * i);
				geometries.push(geometry);
				materials.push(material);
				const pivot = new Group();
				pivot.add(band);
				group.add(pivot);
				spinners.push({ object: pivot, axis: i % 2 === 0 ? "y" : "x", rate: 0.3 + i * 0.15 });
			}
			break;
		case "grid": {
			const count = 24 * 48;
			const positions = new Float32Array(count * 3);
			let k = 0;
			for (let lat = 0; lat < 24; lat++) {
				const phi = ((lat + 0.5) / 24) * Math.PI;
				for (let lon = 0; lon < 48; lon++) {
					const theta = (lon / 48) * Math.PI * 2;
					positions[k++] = 1.3 * Math.sin(phi) * Math.cos(theta);
					positions[k++] = 1.3 * Math.cos(phi);
					positions[k++] = 1.3 * Math.sin(phi) * Math.sin(theta);
				}
			}
			const geometry = new BufferGeometry();
			geometry.setAttribute("position", new BufferAttribute(positions, 3));
			addPoints(geometry, hueA, 0.028, 0.85, "y", -0.25);
			break;
		}
		case "shell":
			addPoints(seededCloud(1600, 1.2, 1.32, 1, 3), hueB, 0.02, 0.6, "x", 0.9);
			break;
		case "twins":
			for (let i = 0; i < 2; i++) {
				const geometry = new SphereGeometry(0.2, 32, 32);
				const material = new MeshBasicMaterial({ color: i === 0 ? hueA : hueB });
				const twin = new Mesh(geometry, material);
				twin.position.set(i === 0 ? 1.7 : -1.7, 0, 0);
				geometries.push(geometry);
				materials.push(material);
				const pivot = new Group();
				pivot.rotation.x = 0.4;
				pivot.add(twin);
				group.add(pivot);
				spinners.push({ object: pivot, axis: "y", rate: 1.1 });
			}
			break;
		case "none":
			break;
	}

	// A generous invisible sphere: grabbing "the core" should not require
	// pixel-hunting a displaced surface.
	const hitGeometry = new SphereGeometry(1.5, 16, 16);
	const hitMaterial = new MeshBasicMaterial({ visible: false });
	const hit = new Mesh(hitGeometry, hitMaterial);
	geometries.push(hitGeometry);
	materials.push(hitMaterial);
	group.add(hit);

	group.scale.setScalar(scale);

	return {
		group,
		hit,
		setEnergy(energy) {
			uniforms.uEnergy.value = energy;
		},
		tick(time, dt) {
			uniforms.uTime.value = time;
			const pace = 0.6 + uniforms.uEnergy.value * 1.2;
			for (const spinner of spinners) spinner.object.rotation[spinner.axis] += spinner.rate * dt * pace;
		},
		dispose() {
			for (const geometry of geometries) geometry.dispose();
			for (const material of materials) material.dispose();
		},
	};
}
