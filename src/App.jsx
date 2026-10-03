/**
 * ============================================================================
 *  ІНТЕРАКТИВНА КАРТА КВАРТАЛУ  —  src/App.jsx  (версія 9)
 * ============================================================================
 *  Залежності:  npm i leaflet react-leaflet lucide-react @supabase/supabase-js
 *  Клієнт Supabase: src/supabaseClient.js (експортує `supabase`).
 *
 *  Дані: таблиці `buildings`, `parkings`, `recreation_zones` (у кожній: address text,
 *  photos — масив посилань text[] (для buildings допускається і jsonb), geometry jsonb
 *  у WGS84 [довгота, широта]). Фото завантажуються в Supabase Storage (бакет PHOTOS_BUCKET). Рядки завантажуються
 *  через supabase.from('buildings').select('*') і перетворюються на GeoJSON
 *  FeatureCollection (rowsToFeatureCollection) для Leaflet.
 *
 *  Авторизація: Supabase Auth (email + пароль). Кнопка «Вхід в акаунт» /
 *  email + «Вийти» розташована в шапці (header), по центру по вертикалі.
 *  Редагування (додавання, зміна, переміщення, видалення, фото) доступне
 *  ТІЛЬКИ авторизованим користувачам; гості бачать карту в режимі перегляду.
 *
 *  Дані: єдине джерело правди — Supabase. localStorage НЕ використовується.
 *  Збереження форми, переміщення, видалення та фото виконуються через
 *  supabase.from('buildings').insert / update / delete; після успіху список
 *  перезавантажується (fetchBuildings). При помилці показується alert, а
 *  стан на екрані не змінюється.
 * ============================================================================
 */

import { Fragment, useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  MapContainer,
  TileLayer,
  LayersControl,
  GeoJSON,
  Popup,
  Polyline,
  Polygon,
  CircleMarker,
  Marker,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  Search,
  Plus,
  X,
  Pencil,
  Trash2,
  ImagePlus,
  Link as LinkIcon,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Check,
  Layers,
  Wrench,
  TreePine,
  Building2,
  Store,
  ParkingSquare,
  Landmark,
  MapPin,
  Move,
  Loader2,
  AlertTriangle,
  LogIn,
  LogOut,
  User,
  Ruler,
} from "lucide-react";
import { supabase } from "./supabaseClient";

/* ============================================================================
 *  1. НАЛАШТУВАННЯ ТА КАТЕГОРІЇ
 * ============================================================================ */
const DEFAULT_CENTER = [49.8397, 24.0297]; // запасний центр, поки дані не завантажились
const DEFAULT_ZOOM = 16;

// Порядок у CATEGORY_PRIORITY = пріоритет кольору на карті (від найвищого до найнижчого).
// Щоб додати категорію — додайте рядок: вона з'явиться у фільтрах, статистиці, легенді й формі.
//   color  — заливка на карті та в легенді
//   stroke — контур на карті (за замовчуванням = color)
//   dash   — пунктир контуру (необов'язково)
//   minFill — мінімальна непрозорість заливки (для світлих кольорів)
//   ui     — насичений колір для тексту / бейджів / кнопок з білим написом (за замовчуванням = color)
const CATEGORIES = Object.fromEntries(
  Object.entries({
    residential: { label: "Житлові", color: "#2f5d8a", Icon: Building2 },
    commercial: { label: "Комерція", color: "#c9741a", Icon: Store },
    public: { label: "Громадські будівлі", color: "#7a4b94", Icon: Landmark },
    // Рекреація — зелений
    recreation: { label: "Рекреація", color: "#4CAF50", stroke: "#2E7D32", ui: "#2E7D32", Icon: TreePine },
    // Паркінг — нейтральний світло-сірий із виразним контуром
    parking: { label: "Паркінг", color: "#E0E0E0", stroke: "#616161", ui: "#757575", minFill: 0.65, Icon: ParkingSquare },
    // Технічні — холодний сіро-блакитний із пунктирним контуром (щоб не плутати з паркінгом)
    technical: { label: "Технічні", color: "#CFD8DC", stroke: "#455A64", ui: "#607D8B", minFill: 0.65, dash: "5 4", Icon: Wrench },
  }).map(([key, c]) => [key, { stroke: c.color, ui: c.color, ...c }])
);
const CATEGORY_PRIORITY = ["residential", "commercial", "public", "recreation", "parking", "technical"];
const getCat = (key) => CATEGORIES[key] || CATEGORIES.residential;

// Головна категорія: колір будівлі на карті визначає найвищий пріоритет
const getPrimaryCategory = (categories) => {
  const list = Array.isArray(categories) ? categories : [categories];
  for (const key of CATEGORY_PRIORITY) if (list.includes(key)) return key;
  return list[0] || "residential";
};

// Категорія, чиїм кольором показується будівля, залежно від активного плану (фільтра):
//  • відкрито тематичний план (комерція, громадські, паркінг, технічні) і будівля має цю функцію —
//    колір ЦЬОГО плану;
//  • на плані «Усі» та «Житлові» діє загальний пріоритет (житло переважає).
const getDisplayCategory = (buildingCategories = [], activePlan = "all") => {
  const categories = Array.isArray(buildingCategories) ? buildingCategories : [buildingCategories];
  if (activePlan !== "all" && categories.includes(activePlan)) return activePlan;
  return getPrimaryCategory(categories);
};

// Усі категорії будівлі в порядку пріоритету → "Житлові, Комерція"
const categoryLabels = (categories) =>
  CATEGORY_PRIORITY.filter((k) => (categories || []).includes(k))
    .map((k) => CATEGORIES[k].label)
    .join(", ");

// Теплова карта поверхів: чим вищий будинок, тим насиченіша заливка (базовий колір — від головної категорії)
const FLOOR_BANDS = [
  { max: 2, fill: 0.18, label: "1–2 поверхи" },
  { max: 5, fill: 0.4, label: "3–5 поверхів" },
  { max: 9, fill: 0.65, label: "6–9 поверхів" },
  { max: Infinity, fill: 0.88, label: "10+ поверхів" },
];
const getFloorFill = (floors) => {
  if (floors == null) return 0.1; // кількість поверхів невідома
  return (FLOOR_BANDS.find((b) => floors <= b.max) || FLOOR_BANDS[FLOOR_BANDS.length - 1]).fill;
};

const FILTERS = [
  { key: "all", label: "Усі" },
  ...Object.entries(CATEGORIES).map(([key, c]) => ({ key, label: c.label })),
];

/* ----------------------------------------------------------------------------
 *  ТИПИ ОБ'ЄКТІВ І ТАБЛИЦІ SUPABASE
 *   building   → buildings          (title, category jsonb, floors, entrances, apartments, photos, geometry …)
 *   parking    → parkings           (title, capacity, parking_type, geometry)
 *   recreation → recreation_zones   (title, zone_type, amenities_list jsonb, geometry)
 *  Кожен об'єкт у додатку має id вигляду "kind:dbId", щоб id з різних таблиць не збігались.
 * -------------------------------------------------------------------------- */
const TABLES = { building: "buildings", parking: "parkings", recreation: "recreation_zones" };
const KINDS = {
  building: { label: "Будинок", category: "residential", Icon: Building2 },
  parking: { label: "Паркінг", category: "parking", Icon: ParkingSquare },
  recreation: { label: "Рекреаційна зона", category: "recreation", Icon: TreePine },
};
// У базу пишуться ключі (open …); за потреби змініть на українські назви
const PARKING_TYPES = { open: "Відкрита", underground: "Підземна", multilevel: "Багаторівнева" };
const ZONE_TYPES = { park: "Парк", square: "Сквер", sports: "Спортивний майданчик", playground: "Дитячий майданчик" };
const AMENITIES = ["Лавки", "Освітлення", "Велодоріжки", "Урни", "Фонтан", "Тренажери", "Дитячі гойдалки"];

// Публічний бакет Supabase Storage для фотографій об'єктів (створіть його — див. SQL в інструкції)
const PHOTOS_BUCKET = "object-photos";

// Значення довідника (ключ або українська назва) → ключ; невідоме значення лишається як є
const pickKey = (map, v) => {
  const t = String(v ?? "").trim();
  if (!t) return "";
  if (map[t.toLowerCase()]) return t.toLowerCase();
  const hit = Object.entries(map).find(([, l]) => l.toLowerCase() === t.toLowerCase());
  return hit ? hit[0] : t;
};

// jsonb-масив рядків (або JSON-рядок / "a, b") → масив рядків
function toStringList(raw) {
  let v = raw;
  if (typeof v === "string") {
    const t = v.trim();
    if (t.startsWith("[")) {
      try {
        v = JSON.parse(t);
      } catch {
        v = [t];
      }
    } else v = t ? t.split(",") : [];
  }
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map((x) => String(x).trim()).filter(Boolean))];
}

/* ============================================================================
 *  2. SUPABASE → GeoJSON FeatureCollection → ОБ'ЄКТИ ДОДАТКУ
 * ============================================================================ */

// Геометрія в колонці jsonb зазвичай уже об'єкт; на випадок рядка / Feature — розбираємо
function toGeometry(g) {
  try {
    if (typeof g === "string") g = JSON.parse(g);
    if (g && g.type === "Feature") g = g.geometry;
    return g && g.coordinates ? g : null;
  } catch {
    return null;
  }
}

// Масив рядків таблиці → GeoJSON FeatureCollection (усі колонки, крім geometry, йдуть у properties)
function rowsToFeatureCollection(rows) {
  const features = [];
  rows.forEach((row, i) => {
    const geometry = toGeometry(row.geometry);
    if (!geometry) return; // рядки без придатної геометрії пропускаємо
    const { geometry: _omit, ...properties } = row;
    features.push({ type: "Feature", id: row.id ?? `r${i}`, geometry, properties });
  });
  return { type: "FeatureCollection", features };
}

// Одне значення категорії (ключ, стара назва «commerce» або українська назва) → ключ або null
function normCategory(value) {
  const v = String(value ?? "").toLowerCase().trim();
  if (CATEGORIES[v]) return v;
  if (v === "commerce") return "commercial"; // стара назва ключа
  const byLabel = Object.entries(CATEGORIES).find(([, c]) => c.label.toLowerCase() === v);
  return byLabel ? byLabel[0] : null;
}

// Колонка category (jsonb-масив) → масив ключів. Терпимо до рядка з JSON, "a,b" та одиночного значення.
function toCategoryKeys(raw) {
  let v = raw;
  if (typeof v === "string") {
    const t = v.trim();
    if (t.startsWith("[")) {
      try {
        v = JSON.parse(t);
      } catch {
        v = [t];
      }
    } else {
      v = t.split(",");
    }
  }
  if (!Array.isArray(v)) v = v == null ? [] : [v];
  const keys = [...new Set(v.map(normCategory).filter(Boolean))];
  return keys.length ? keys : ["residential"];
}

// Колонка photos (text[] або jsonb) → масив посилань; терпимо до рядка з JSON.
// Якщо масив порожній, а в рядку є стара колонка photo_url — показуємо її.
function toPhotos(p) {
  let v = p.photos;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      v = v.trim() ? [v.trim()] : [];
    }
  }
  let list = Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()) : [];
  if (list.length === 0 && p.photo_url) list = [p.photo_url];
  return list;
}

// Feature з FeatureCollection → об'єкт, з яким працює інтерфейс
function featureToBuilding(f, index) {
  const p = f.properties || {};
  const num = (v) => {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? null : n;
  };
  const categories = toCategoryKeys(p.category);
  const floors = num(p.floors);
  const entrances = num(p.entrances);
  const apartments = num(p.apartments);
  return {
    id: `building:${f.id}`,
    dbId: f.id, // справжній id рядка в таблиці
    kind: "building",
    table: TABLES.building,
    name: p.title || `Будівля №${index + 1}`,
    number: p.address || "",
    categories,
    category: getPrimaryCategory(categories), // головна категорія → колір на карті
    status: p.status || "",
    description: p.description || "",
    floors,
    entrances,
    apartments,
    // Рядки для картки об'єкта — складаються з числових колонок
    features: [
      floors != null && `Поверхів: ${floors}`,
      entrances != null && `Під'їздів: ${entrances}`,
      apartments != null && `Квартир: ${apartments}`,
    ].filter(Boolean),
    photos: toPhotos(p),
    geometry: f.geometry,
  };
}

// Рядок parkings → об'єкт додатку
function featureToParking(f, index) {
  const p = f.properties || {};
  const cap = parseInt(p.capacity, 10);
  const capacity = Number.isNaN(cap) ? null : cap;
  const parkingType = pickKey(PARKING_TYPES, p.parking_type);
  return {
    id: `parking:${f.id}`,
    dbId: f.id,
    kind: "parking",
    table: TABLES.parking,
    name: p.title || `Паркінг №${index + 1}`,
    number: p.address || "",
    categories: ["parking"],
    category: "parking",
    status: "",
    description: "",
    capacity,
    parkingType,
    floors: null,
    features: [
      capacity != null && `Машиномісць: ${capacity}`,
      parkingType && `Тип: ${PARKING_TYPES[parkingType] || parkingType}`,
    ].filter(Boolean),
    photos: toPhotos(p), // масив у колонці photos (фолбек — стара photo_url)
    geometry: f.geometry,
  };
}

// Рядок recreation_zones → об'єкт додатку
function featureToRecreation(f, index) {
  const p = f.properties || {};
  const zoneType = pickKey(ZONE_TYPES, p.zone_type);
  const amenities = toStringList(p.amenities_list);
  return {
    id: `recreation:${f.id}`,
    dbId: f.id,
    kind: "recreation",
    table: TABLES.recreation,
    name: p.title || `Зона №${index + 1}`,
    number: p.address || "",
    categories: ["recreation"],
    category: "recreation",
    status: "",
    description: "",
    zoneType,
    amenities,
    floors: null,
    features: [
      zoneType && `Тип: ${ZONE_TYPES[zoneType] || zoneType}`,
      amenities.length > 0 && `Благоустрій: ${amenities.join(", ")}`,
    ].filter(Boolean),
    photos: toPhotos(p),
    geometry: f.geometry,
  };
}

function featureToObject(f, index, kind) {
  if (kind === "parking") return featureToParking(f, index);
  if (kind === "recreation") return featureToRecreation(f, index);
  return featureToBuilding(f, index);
}

// Перша координата геометрії (перевірка, що дані в градусах WGS84, а не в метрах)
function firstCoord(geometry) {
  let c = geometry.coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  return c;
}

/* ============================================================================
 *  3. ГЕОМЕТРІЯ: ПЕРЕМІЩЕННЯ, МЕЖІ, СТАРТОВА ФОРМА
 * ============================================================================ */
function mapCoords(coords, fn) {
  return typeof coords[0] === "number" ? fn(coords) : coords.map((c) => mapCoords(c, fn));
}

function translateGeometry(geometry, dLng, dLat) {
  return {
    ...geometry,
    coordinates: mapCoords(geometry.coordinates, ([x, y, ...rest]) => [x + dLng, y + dLat, ...rest]),
  };
}

function geometryBounds(geometry) {
  return L.geoJSON({ type: "Feature", geometry, properties: {} }).getBounds();
}

// Вершини, поставлені кліками ([lat, lng]), → GeoJSON Polygon (замкнене кільце [lng, lat])
function pointsToPolygon(points) {
  const ring = points.map(([lat, lng]) => [lng, lat]);
  ring.push(ring[0]);
  return { type: "Polygon", coordinates: [ring] };
}

/* ----------------------------------------------------------------------------
 *  ВІДСТАНІ МІЖ БУДИНКАМИ
 *  Координати переводимо в локальну пласку систему (метри) навколо першої точки
 *  (для масштабу кварталу похибка — сантиметри). Для кожної пари будинків шукаємо
 *  найкоротшу відстань між їхніми контурами (ребро ↔ ребро). Залишаємо лише
 *  «сусідні» пари: ближче за DISTANCE_MAX_M, не далі DISTANCE_PER_BUILDING
 *  найближчих сусідів кожного будинку, і без відрізків, що перетинають третій будинок.
 * -------------------------------------------------------------------------- */
const DISTANCE_KINDS = ["building"]; // між якими типами об'єктів рахуємо (додайте "parking" за потреби)
const DISTANCE_MAX_M = 60;
const DISTANCE_PER_BUILDING = 3;
const M_PER_DEG = (Math.PI / 180) * 6371008.8;

// Стабільний ключ пари: id у фіксованому порядку (однаковий для (A,B) і (B,A))
const pairIds = (x, y) =>
  [x, y].sort((m, n) => String(m).localeCompare(String(n), undefined, { numeric: true }));

const fmtMeters = (v) => `${v.toLocaleString("uk-UA", { maximumFractionDigits: 1 })} м`;

function polyRings(geometry) {
  if (geometry?.type === "Polygon") return [geometry.coordinates[0]];
  if (geometry?.type === "MultiPolygon") return geometry.coordinates.map((poly) => poly[0]);
  return [];
}

// Найближча до точки p точка відрізка ab
function pointSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const q = [a[0] + t * dx, a[1] + t * dy];
  return { q, d: Math.hypot(p[0] - q[0], p[1] - q[1]) };
}

// Чи перетинаються відрізки ab і cd (власний перетин)
function segCross(a, b, c, d) {
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

// Найкоротша відстань між двома відрізками: { d, p (на ab), q (на cd) }
function segSegDist(a, b, c, d) {
  if (segCross(a, b, c, d)) return { d: 0, p: a, q: a };
  let best = null;
  const tryPoint = (pt, s1, s2, flip) => {
    const { q, d: dist } = pointSeg(pt, s1, s2);
    if (!best || dist < best.d) best = flip ? { d: dist, p: q, q: pt } : { d: dist, p: pt, q };
  };
  tryPoint(a, c, d, false);
  tryPoint(b, c, d, false);
  tryPoint(c, a, b, true);
  tryPoint(d, a, b, true);
  return best;
}

const bboxGap = (a, b) =>
  Math.hypot(
    Math.max(0, a.minX - b.maxX, b.minX - a.maxX),
    Math.max(0, a.minY - b.maxY, b.minY - a.maxY)
  );

function shapeDistance(sa, sb) {
  let best = null;
  for (const ra of sa.rings)
    for (let i = 0; i < ra.length - 1; i++)
      for (const rb of sb.rings)
        for (let j = 0; j < rb.length - 1; j++) {
          const r = segSegDist(ra[i], ra[i + 1], rb[j], rb[j + 1]);
          if (!best || r.d < best.d) best = r;
        }
  return best;
}

function computeBuildingDistances(objects) {
  const items = objects.filter((o) => DISTANCE_KINDS.includes(o.kind) && o.dbId != null && polyRings(o.geometry).length);
  if (items.length < 2) return [];

  const [lng0, lat0] = firstCoord(items[0].geometry);
  const kx = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  const toXY = ([lng, lat]) => [(lng - lng0) * kx, (lat - lat0) * M_PER_DEG];
  const toLL = ([x, y]) => [lat0 + y / M_PER_DEG, lng0 + x / kx];

  const shapes = items.map((o) => {
    const rings = polyRings(o.geometry).map((r) => r.map(toXY));
    const pts = rings.flat();
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    return { o, rings, minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  });

  // Відрізок p–q перетинає контур якогось третього будинку?
  const blocked = (p, q, skipI, skipJ) => {
    const seg = { minX: Math.min(p[0], q[0]), maxX: Math.max(p[0], q[0]), minY: Math.min(p[1], q[1]), maxY: Math.max(p[1], q[1]) };
    return shapes.some((sh, k) => {
      if (k === skipI || k === skipJ || bboxGap(seg, sh) > 0) return false;
      return sh.rings.some((r) => r.some((pt, e) => e < r.length - 1 && segCross(p, q, pt, r[e + 1])));
    });
  };

  const cands = [];
  for (let i = 0; i < shapes.length; i++)
    for (let j = i + 1; j < shapes.length; j++) {
      if (bboxGap(shapes[i], shapes[j]) > DISTANCE_MAX_M) continue;
      const best = shapeDistance(shapes[i], shapes[j]);
      if (!best || best.d < 0.05 || best.d > DISTANCE_MAX_M) continue; // дотичні / перекриті / задалеко
      if (blocked(best.p, best.q, i, j)) continue;
      cands.push({ i, j, ...best });
    }

  // Кожному будинку — лише його найближчі сусіди
  const keep = new Set();
  shapes.forEach((_, idx) => {
    cands
      .filter((c) => c.i === idx || c.j === idx)
      .sort((x, y) => x.d - y.d)
      .slice(0, DISTANCE_PER_BUILDING)
      .forEach((c) => keep.add(c));
  });

  return [...keep].map((c) => {
    const A = shapes[c.i].o, B = shapes[c.j].o;
    const [aDb, bDb] = pairIds(A.dbId, B.dbId);
    const from = toLL(c.p), to = toLL(c.q);
    return {
      key: `${aDb}|${bDb}`,
      aDb, bDb,
      aId: A.id, bId: B.id,
      names: [A.name, B.name],
      meters: Math.round(c.d * 10) / 10,
      from, to,
      mid: [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2],
    };
  });
}

/* ============================================================================
 *  4. ФОТО → SUPABASE STORAGE
 *   Файли стискаються в браузері (до 1600 px, JPEG) і завантажуються в бакет
 *   PHOTOS_BUCKET. У базу (колонка photos) записуються лише публічні посилання.
 * ============================================================================ */

// Стискання зображення; якщо браузер не вміє його прочитати — повертаємо оригінальний файл
function compressImage(file, maxSide = 1600, quality = 0.85) {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(file);
    };
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => resolve(blob || file), "image/jpeg", quality);
    };
    img.src = objectUrl;
  });
}

function explainStorageError(err) {
  const msg = err?.message || String(err);
  if (/bucket not found/i.test(msg))
    return `Бакет «${PHOTOS_BUCKET}» не знайдено. Створіть його в Supabase Storage (SQL — в інструкції).`;
  if (/row-level security|not authorized|unauthorized|permission/i.test(msg))
    return "Немає прав на завантаження файлів (політика Storage для authenticated). Перевірте, що ви увійшли в акаунт.";
  return msg;
}

// Завантажує файли по одному; повертає { urls: [...публічні посилання], errors: [...] }
async function uploadPhotos(files, folder = "misc") {
  const urls = [];
  const errors = [];
  for (const file of files) {
    try {
      const blob = await compressImage(file);
      const ext = blob.type === "image/jpeg" ? "jpg" : (file.name.split(".").pop() || "bin").toLowerCase();
      const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { error } = await supabase.storage
        .from(PHOTOS_BUCKET)
        .upload(path, blob, { contentType: blob.type || file.type, cacheControl: "31536000", upsert: false });
      if (error) throw error;
      urls.push(supabase.storage.from(PHOTOS_BUCKET).getPublicUrl(path).data.publicUrl);
    } catch (err) {
      console.error("Storage upload error:", err);
      errors.push(`${file.name}: ${explainStorageError(err)}`);
    }
  }
  return { urls, errors };
}

// Видаляє з Storage файли за публічними посиланнями (best effort; чужі / base64-посилання ігноруються)
async function removeFromStorage(urls) {
  const marker = `/storage/v1/object/public/${PHOTOS_BUCKET}/`;
  const paths = (urls || [])
    .filter((u) => typeof u === "string" && u.includes(marker))
    .map((u) => decodeURIComponent(u.split(marker)[1].split("?")[0]));
  if (paths.length === 0) return;
  const { error } = await supabase.storage.from(PHOTOS_BUCKET).remove(paths);
  if (error) console.warn("Не вдалося видалити файли зі Storage:", error);
}

/* ============================================================================
 *  4б. ЗАПИС У SUPABASE: мапінг полів і допоміжні функції
 *   назва → title, адреса → address, категорії → category (jsonb-масив), статус → status,
 *   опис → description, поверхи → floors, під'їзди → entrances,
 *   квартири → apartments, масив фото → photos (jsonb).
 *   Надсилаються лише ті колонки, які реально є в таблиці (визначаємо за
 *   рядками, отриманими з бази), тож відсутня колонка не ламає запит.
 * ============================================================================ */
function buildDbPayload(data, meta) {
  const all = {
    title: data.name,
    address: data.number || null,
    category: Array.isArray(data.categories) && data.categories.length ? data.categories : ["residential"], // jsonb-масив
    status: data.status || null,
    description: data.description || null,
    floors: Number(data.floors) || 1,
    entrances: Number(data.entrances) || 1,
    apartments: Number(data.apartments) || 0,
    photos: Array.isArray(data.photos) ? data.photos : [], // масив посилань (text[] / jsonb)
    photo_url: (Array.isArray(data.photos) && data.photos[0]) || null, // лише якщо така колонка є (фільтр нижче)
  };
  if (!meta.columns) return all;
  return Object.fromEntries(Object.entries(all).filter(([k]) => meta.columns.has(k)));
}

function explainDbError(err) {
  const msg = err?.message || String(err);
  const col = msg.match(/could not find the '([^']+)' column of '([^']+)'/i);
  if (col)
    return `У таблиці «${col[2]}» немає колонки «${col[1]}». Додайте її (SQL — в інструкції), оновіть сторінку й повторіть.`;
  if (err?.code === "42501" || /row-level security/i.test(msg))
    return "Немає прав на запис у базу (політика RLS). Перевірте політики INSERT/UPDATE/DELETE для авторизованих користувачів.";
  if (/failed to fetch|networkerror|network request/i.test(msg))
    return "Немає з'єднання із сервером. Перевірте інтернет і спробуйте ще раз.";
  return msg;
}

const EMPTY_FORM = {
  id: null, // "kind:dbId" (null = новий об'єкт)
  dbId: null,
  kind: "building", // building | parking | recreation
  geometry: null, // накреслений контур нового об'єкта (GeoJSON Polygon)
  capacity: "", // паркінг
  parkingType: "open",
  zoneType: "park", // рекреація
  amenities: [],
  name: "",
  number: "",
  categories: ["residential"],
  status: "",
  description: "",
  floors: "",
  entrances: "",
  apartments: "",
  photos: [],
};

/* ============================================================================
 *  5. ДОПОМІЖНІ КОМПОНЕНТИ КАРТИ (всередині <MapContainer>)
 * ============================================================================ */
function ResizeWatcher() {
  const map = useMap();
  useEffect(() => {
    const observer = new ResizeObserver(() => map.invalidateSize({ animate: false }));
    observer.observe(map.getContainer());
    return () => observer.disconnect();
  }, [map]);
  return null;
}

/* Креслення полігона послідовними кліками: вершини, лінія та фігура в реальному часі.
   Клік по першій вершині (або Enter) замикає контур; Backspace — прибрати останню точку; Esc — скасувати. */
function DrawLayer({ kind, points, onAdd, onUndo, onFinish, onCancel }) {
  const map = useMap();
  const [cursor, setCursor] = useState(null);
  const cat = getCat(KINDS[kind].category);

  // Подвійний клік не має масштабувати карту під час креслення
  useEffect(() => {
    map.doubleClickZoom.disable();
    return () => map.doubleClickZoom.enable();
  }, [map]);

  useMapEvents({
    click(e) {
      onAdd([e.latlng.lat, e.latlng.lng]);
    },
    mousemove(e) {
      setCursor([e.latlng.lat, e.latlng.lng]);
    },
    mouseout() {
      setCursor(null);
    },
  });

  useEffect(() => {
    const onKey = (e) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || "")) return;
      if (e.key === "Enter") onFinish();
      else if (e.key === "Escape") onCancel();
      else if (e.key === "Backspace") {
        e.preventDefault();
        onUndo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onFinish, onCancel, onUndo]);

  const rubber = cursor && points.length > 0 ? [...points, cursor] : points; // «гумова» лінія до курсора
  return (
    <>
      {points.length >= 3 && (
        <Polygon
          positions={points}
          interactive={false}
          pathOptions={{ color: cat.stroke, weight: 2, fillColor: cat.color, fillOpacity: Math.max(0.35, cat.minFill ?? 0) }}
        />
      )}
      {rubber.length >= 2 && (
        <Polyline positions={rubber} interactive={false} pathOptions={{ color: cat.stroke, weight: 2.5, dashArray: "6 6" }} />
      )}
      {points.map((pt, i) => (
        <CircleMarker
          key={i}
          center={pt}
          radius={i === 0 && points.length >= 3 ? 9 : 5}
          bubblingMouseEvents={false} // клік по вершині не додає дубль точки
          eventHandlers={i === 0 ? { click: () => points.length >= 3 && onFinish() } : {}}
          pathOptions={{ color: cat.stroke, weight: 2, fillColor: "#ffffff", fillOpacity: 1 }}
        />
      ))}
    </>
  );
}

// Один раз після завантаження даних показує весь квартал
/* Мінімодалка редагування відстані (у Popup на карті) */
function DistanceEditor({ pair, current, edited, onSave, onReset, onClose }) {
  const [val, setVal] = useState(String(current));
  const [busy, setBusy] = useState(false);
  const num = parseFloat(val.replace(",", "."));
  const valid = Number.isFinite(num) && num > 0 && num <= 10000;

  const wrapRef = useCallback((el) => {
    if (el) {
      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);
    }
  }, []);

  const run = async (fn) => {
    setBusy(true);
    const ok = await fn();
    setBusy(false);
    if (ok) onClose();
  };
  const submit = () => valid && !busy && run(() => onSave(pair, Math.round(num * 100) / 100));

  return (
    <div ref={wrapRef} className="w-[220px] text-sm">
      <div className="font-semibold">Відстань між будинками</div>
      <div className="mb-2 mt-0.5 text-xs leading-snug text-stone-500">
        {pair.names[0]} ↔ {pair.names[1]}
        <br />
        Розрахункова: {fmtMeters(pair.meters)}
      </div>
      <div className="flex items-center gap-1.5">
        <input
          autoFocus
          inputMode="decimal"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onClose();
          }}
          className={`w-full rounded-md border px-2 py-1.5 outline-none focus:ring-2 focus:ring-[#2f5d8a]/25 ${
            valid ? "border-stone-300 focus:border-[#2f5d8a]" : "border-red-400"
          }`}
        />
        <span className="text-stone-500">м</span>
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <button
          onClick={submit}
          disabled={!valid || busy}
          className="flex items-center gap-1 rounded-md bg-[#2f5d8a] px-3 py-1.5 font-medium text-white disabled:opacity-40"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Зберегти
        </button>
        {edited && (
          <button
            onClick={() => run(() => onReset(pair))}
            disabled={busy}
            className="rounded-md border border-stone-300 px-2.5 py-1.5 hover:bg-stone-50 disabled:opacity-40"
            title="Повернути розрахункове значення"
          >
            Скинути
          </button>
        )}
        <button onClick={onClose} className="ml-auto text-xs text-stone-500 underline underline-offset-2">
          Скасувати
        </button>
      </div>
    </div>
  );
}

/* Лінії та мітки відстаней (всередині <MapContainer>) */
function DistanceLayer({ pairs, overrides, canEdit, interactive, editing, setEditing, onSave, onReset }) {
  const icons = useRef(new Map());
  const getIcon = (text, edited) => {
    const k = `${text}|${edited}`;
    if (!icons.current.has(k))
      icons.current.set(
        k,
        L.divIcon({
          className: "dist-label-wrap",
          iconSize: [0, 0],
          html: `<span class="dist-label${edited ? " dist-label--edited" : ""}">${text}${edited ? " ✎" : ""}</span>`,
        })
      );
    return icons.current.get(k);
  };

  const editable = canEdit && interactive;
  const editPair = editing ? pairs.find((p) => p.key === editing.key) : null;
  const closeEditor = () => setEditing(null);

  return (
    <>
      {pairs.map((p) => {
        const ov = overrides[p.key];
        const meters = ov ? ov.meters : p.meters;
        return (
          <Fragment key={`${p.key}|${editable}`}>
            <Polyline
              positions={[p.from, p.to]}
              interactive={false}
              pathOptions={{ color: ov ? "#d97706" : "#111827", weight: 1.6, dashArray: "4 3", opacity: 0.85 }}
            />
            <Marker
              position={p.mid}
              icon={getIcon(fmtMeters(meters), !!ov)}
              interactive={editable}
              keyboard={false}
              zIndexOffset={500}
              eventHandlers={{ click: () => setEditing({ key: p.key, stamp: Date.now() }) }}
            />
          </Fragment>
        );
      })}

      {editable && editPair && (
        <Popup
          key={editing.stamp}
          position={editPair.mid}
          closeButton={false}
          minWidth={230}
          eventHandlers={{ remove: () => setEditing((cur) => (cur && cur.stamp === editing.stamp ? null : cur)) }}
        >
          <DistanceEditor
            pair={editPair}
            current={overrides[editPair.key]?.meters ?? editPair.meters}
            edited={!!overrides[editPair.key]}
            onSave={onSave}
            onReset={onReset}
            onClose={closeEditor}
          />
        </Popup>
      )}
    </>
  );
}

function FitToData({ bounds }) {
  const map = useMap();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !bounds || !bounds.isValid()) return;
    map.fitBounds(bounds, { padding: [30, 30], animate: false });
    done.current = true;
  }, [bounds, map]);
  return null;
}

// Фокус на вибраному будинку (tick дозволяє повторно сфокусуватись на тому ж)
function FocusOnSelected({ building, tick }) {
  const map = useMap();
  useEffect(() => {
    if (!building) return;
    const bounds = geometryBounds(building.geometry);
    if (!bounds.isValid()) return;
    map.flyToBounds(bounds, { padding: [80, 80], maxZoom: 19, duration: 0.6 });
  }, [building?.id, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// Клік по порожньому місцю: або знімає вибір, або переміщує об'єкт
function MapClicks({ placing, onPlace, onEmptyClick }) {
  useMapEvents({
    click(e) {
      if (placing) onPlace(e.latlng);
      else onEmptyClick();
    },
  });
  return null;
}

/* ----------------------------------------------------------------------------
 *  Випадаюче меню фільтра категорій (замість ряду кнопок у шапці)
 * -------------------------------------------------------------------------- */
function FilterDropdown({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const current = FILTERS.find((f) => f.key === value) || FILTERS[0];
  const currentCat = value !== "all" ? CATEGORIES[value] : null;

  // Закриваємо по кліку поза меню та по Esc
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`flex h-10 items-center gap-2 rounded-lg border bg-stone-50 px-3 text-sm font-medium outline-none transition hover:bg-white focus:ring-2 focus:ring-[#2f5d8a]/20 ${
          open ? "border-[#2f5d8a] bg-white" : "border-stone-300"
        }`}
      >
        {currentCat ? (
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ background: currentCat.color, border: `1.5px solid ${currentCat.stroke}` }}
          />
        ) : (
          <Layers size={15} className="text-stone-500" />
        )}
        <span className="text-stone-500">Фільтр:</span>
        <span className="max-w-[10rem] truncate">{current.label}</span>
        <ChevronDown size={16} className={`text-stone-500 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <ul
          role="listbox"
          className="absolute left-0 top-full z-[1500] mt-1.5 w-60 overflow-hidden rounded-xl border border-stone-200 bg-white py-1.5 shadow-xl shadow-stone-900/10"
        >
          {FILTERS.map((f) => {
            const c = f.key !== "all" ? CATEGORIES[f.key] : null;
            const active = f.key === value;
            return (
              <li key={f.key} role="option" aria-selected={active}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(f.key);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm transition ${
                    active ? "bg-[#2f5d8a]/5 font-semibold text-[#2f5d8a]" : "text-stone-700 hover:bg-stone-100"
                  }`}
                >
                  {c ? (
                    <span
                      className="h-3 w-3 shrink-0 rounded-sm"
                      style={{ background: c.color, border: `1.5px solid ${c.stroke}` }}
                    />
                  ) : (
                    <Layers size={14} className="shrink-0 text-stone-400" />
                  )}
                  <span className="flex-1">{f.label}</span>
                  {active && <Check size={15} />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* Кнопка «Додати об'єкт» з вибором типу: після вибору починається креслення контуру */
function AddObjectMenu({ canEdit, onPick, onNeedLogin }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => (canEdit ? setOpen((o) => !o) : onNeedLogin())}
        title={canEdit ? "Накреслити новий об'єкт" : "Увійдіть, щоб додавати об'єкти"}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-10 items-center gap-1.5 rounded-lg bg-[#2f5d8a] px-4 text-sm font-semibold text-white hover:bg-[#264d73]"
      >
        <Plus size={16} /> Додати об'єкт <ChevronDown size={15} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <ul
          role="menu"
          className="absolute right-0 top-full z-[1500] mt-1.5 w-64 overflow-hidden rounded-xl border border-stone-200 bg-white py-1.5 shadow-xl shadow-stone-900/10"
        >
          {Object.entries(KINDS).map(([kind, k]) => {
            const c = getCat(k.category);
            return (
              <li key={kind} role="menuitem">
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onPick(kind);
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-sm text-stone-700 hover:bg-stone-100"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-white" style={{ background: c.ui }}>
                    <k.Icon size={15} />
                  </span>
                  <span className="leading-tight">
                    <span className="block font-medium">{k.label}</span>
                    <span className="block text-xs text-stone-500">накреслити контур на карті</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function BuildingPopupContent({ building: b, activePlan, onDetails }) {
  const cat = getCat(getDisplayCategory(b.categories, activePlan));
  return (
    <div className="text-stone-800" style={{ fontFamily: "'Onest', system-ui, sans-serif" }}>
      {b.photos?.[0] && (
        <img src={b.photos[0]} alt={b.name} className="mb-2 h-24 w-full rounded-md object-cover" />
      )}
      <div className="text-xs font-semibold" style={{ color: cat.ui }}>
        Категорії: {categoryLabels(b.categories)}
      </div>
      <div className="mt-0.5 text-sm font-bold leading-snug">{b.name}</div>
      {b.number && <div className="mt-0.5 text-xs text-stone-500">{b.number}</div>}
      {/* Паркінг: машиномісця й тип; зона: тип і благоустрій */}
      {b.kind !== "building" && b.features?.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs text-stone-600">
          {b.features.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      )}
      <button
        onClick={() => onDetails(b.id)}
        className="mt-2 w-full rounded-md px-3 py-1.5 text-xs font-semibold text-white"
        style={{ background: cat.ui }}
      >
        Переглянути деталі
      </button>
    </div>
  );
}

/* ============================================================================
 *  6. ПАНЕЛЬ АВТОРИЗАЦІЇ — всередині шапки, у загальному flex-ряду.
 *  Висота h-10 збігається з кнопкою «Додати об'єкт», тому вони рівні
 *  по вертикалі; items-center у header центрує їх відносно шапки.
 * ============================================================================ */
function AuthPanel({ session, onLogin, onLogout }) {
  if (session) {
    return (
      <div className="flex h-10 shrink-0 items-center gap-2 rounded-lg bg-slate-900 pl-3 pr-1 text-white">
        <User size={16} className="shrink-0" />
        <span className="hidden max-w-[180px] truncate text-sm md:inline" title={session.user.email}>
          {session.user.email}
        </span>
        <button
          onClick={onLogout}
          className="flex h-8 items-center gap-1.5 rounded-md bg-white px-3 text-sm font-semibold text-slate-900 hover:bg-slate-100"
        >
          <LogOut size={15} /> Вийти
        </button>
      </div>
    );
  }
  return (
    <button
      onClick={onLogin}
      className="flex h-10 shrink-0 items-center gap-2 rounded-lg bg-[#1d4ed8] px-4 text-sm font-semibold text-white hover:bg-[#1e40af]"
    >
      <LogIn size={17} /> Вхід в акаунт
    </button>
  );
}

/* ============================================================================
 *  7. ГОЛОВНИЙ КОМПОНЕНТ
 * ============================================================================ */
export default function App() {
  // --- Дані ---
  const [base, setBase] = useState([]); // об'єкти з Supabase
  const [load, setLoad] = useState({ status: "loading", error: "" });
  const [geoRev, setGeoRev] = useState(0); // збільшуємо, коли змінились контури → перемальовуємо шар

  // --- Авторизація ---
  const [session, setSession] = useState(null); // null = гість
  const [loginOpen, setLoginOpen] = useState(false);

  // --- Інтерфейс ---
  const [selectedId, setSelectedId] = useState(null);
  const [hoveredId, setHoveredId] = useState(null);
  const [popup, setPopup] = useState(null); // { id, latlng, stamp }
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [placingId, setPlacingId] = useState(null);
  const [drawing, setDrawing] = useState(null); // { kind, points: [[lat, lng], …] } — триває креслення
  const [activePhoto, setActivePhoto] = useState(0);
  const [focusTick, setFocusTick] = useState(0);
  const [heatMode, setHeatMode] = useState(false); // підсвітка за поверховістю
  const [saving, setSaving] = useState(false); // триває запис у Supabase (форма)
  const [uploading, setUploading] = useState(false); // триває завантаження фото в Storage (панель об'єкта)
  // Легенда карти: на телефонах (< 768px) за замовчуванням згорнута
  const [legendOpen, setLegendOpen] = useState(
    () => typeof window === "undefined" || window.matchMedia("(min-width: 768px)").matches
  );
  const [showDistances, setShowDistances] = useState(false); // шар «Відстані між будинками»
  const [distOverrides, setDistOverrides] = useState({}); // "aId|bId" → { meters }
  const [distEditing, setDistEditing] = useState(null); // { key, stamp }

  const mapRef = useRef(null);
  const geoRef = useRef(null);
  const asideRef = useRef(null);
  const dbMeta = useRef({ columns: null }); // колонки таблиці

  /* ------------------------------------------------------------------------
   *  Сесія Supabase Auth: поточна сесія + слухач змін
   * ------------------------------------------------------------------------ */
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      if (newSession) setLoginOpen(false); // успішний вхід → закриваємо модальне вікно
    });

    return () => subscription.unsubscribe();
  }, []);

  const userId = session?.user?.id ?? null;
  const canEdit = !!session; // редагування — тільки для авторизованих

  // Вихід з акаунта: закриваємо форму редагування й скасовуємо режим переміщення
  useEffect(() => {
    if (!session) {
      setModalOpen(false);
      setPlacingId(null);
      setDrawing(null);
    }
  }, [session]);

  /* ------------------------------------------------------------------------
   *  Завантаження об'єктів із Supabase — buildings, parkings, recreation_zones (при старті, після входу / виходу та
   *  після кожного успішного запису)
   * ------------------------------------------------------------------------ */
  const fetchBuildings = useCallback(async () => {
    try {
      // Три таблиці паралельно: buildings, parkings, recreation_zones
      const kinds = Object.keys(TABLES);
      const results = await Promise.all(kinds.map((k) => supabase.from(TABLES[k]).select("*")));

      const objects = [];
      results.forEach((res, i) => {
        const kind = kinds[i];
        if (res.error) throw new Error(`Таблиця ${TABLES[kind]}: ${res.error.message}`);
        const rows = res.data || [];

        // Колонки buildings запам'ятовуємо, щоб не надсилати неіснуючі
        if (kind === "building" && rows.length > 0) {
          dbMeta.current = { columns: new Set(Object.keys(rows[0])) };
        }

        const fc = rowsToFeatureCollection(rows);
        fc.features.forEach((f, j) => objects.push(featureToObject(f, j, kind)));
      });

      // Перевірка: координати мають бути в градусах (WGS84)
      if (objects.length > 0) {
        const [x, y] = firstCoord(objects[0].geometry);
        if (Math.abs(x) > 180 || Math.abs(y) > 90) {
          throw new Error("Координати схожі на проєкційні (метри). Збережіть геометрію у WGS84 (EPSG:4326).");
        }
      }

      setBase(objects); // тут «base / buildings» — це всі об'єкти: будинки, паркінги, зони
      setLoad({ status: "ready", error: "" });
      setGeoRev((r) => r + 1);
    } catch (err) {
      console.error(err);
      setLoad({ status: "error", error: err.message || String(err) });
    }
  }, []);

  useEffect(() => {
    fetchBuildings();
  }, [fetchBuildings, userId]);

  // Єдине джерело правди — дані з Supabase (жодних локальних правок поверх них)
  const buildings = base;

  const byId = useMemo(() => new Map(buildings.map((b) => [b.id, b])), [buildings]);
  const selected = selectedId ? byId.get(selectedId) || null : null;

  const dataBounds = useMemo(() => {
    if (base.length === 0) return null;
    return L.geoJSON({
      type: "FeatureCollection",
      features: base.map((b) => ({ type: "Feature", geometry: b.geometry, properties: {} })),
    }).getBounds();
  }, [base]);

  useEffect(() => {
    setActivePhoto(0);
    asideRef.current?.scrollTo({ top: 0 });
  }, [selectedId]);

  /* ------------------------------------------------------------------------
   *  Пошук + фільтр
   * ------------------------------------------------------------------------ */
  const visibleIds = useMemo(() => {
    const q = query.trim().toLowerCase();
    return new Set(
      buildings
        .filter((b) => filter === "all" || b.categories.includes(filter))
        .filter((b) => !q || b.name.toLowerCase().includes(q) || (b.number || "").toLowerCase().includes(q))
        .map((b) => b.id)
    );
  }, [buildings, filter, query]);

  const visibleList = useMemo(() => buildings.filter((b) => visibleIds.has(b.id)), [buildings, visibleIds]);

  /* ------------------------------------------------------------------------
   *  Відстані між будинками: розрахунок із геометрії + збережені правки (building_distances)
   * ------------------------------------------------------------------------ */
  const distancePairs = useMemo(() => computeBuildingDistances(buildings), [buildings]);
  const visiblePairs = useMemo(
    () => distancePairs.filter((p) => visibleIds.has(p.aId) && visibleIds.has(p.bId)),
    [distancePairs, visibleIds]
  );

  const fetchDistanceOverrides = useCallback(async () => {
    const { data, error } = await supabase.from("building_distances").select("*");
    if (error) {
      console.warn("building_distances:", error.message); // таблиці ще немає / немає прав — карта працює без правок
      return;
    }
    const map = {};
    (data || []).forEach((r) => {
      map[pairIds(r.building_a_id, r.building_b_id).join("|")] = { meters: Number(r.distance_m) };
    });
    setDistOverrides(map);
  }, []);

  useEffect(() => {
    fetchDistanceOverrides();
  }, [fetchDistanceOverrides, userId]);

  useEffect(() => {
    if (!showDistances || !canEdit) setDistEditing(null);
  }, [showDistances, canEdit]);

  const saveDistance = async (pair, meters) => {
    if (!canEdit) return false;
    const { error } = await supabase.from("building_distances").upsert(
      { building_a_id: pair.aDb, building_b_id: pair.bDb, distance_m: meters, updated_at: new Date().toISOString() },
      { onConflict: "building_a_id,building_b_id" }
    );
    if (error) {
      alert(explainDbError(error));
      return false;
    }
    await fetchDistanceOverrides();
    return true;
  };

  const resetDistance = async (pair) => {
    if (!canEdit) return false;
    const { error } = await supabase
      .from("building_distances")
      .delete()
      .eq("building_a_id", pair.aDb)
      .eq("building_b_id", pair.bDb);
    if (error) {
      alert(explainDbError(error));
      return false;
    }
    await fetchDistanceOverrides();
    return true;
  };

  /* ------------------------------------------------------------------------
   *  Дані для <GeoJSON> (FeatureCollection для карти).
   *  react-leaflet не оновлює вже створений GeoJSON-шар при зміні data,
   *  тому перемальовуємо його через key (geoKey).
   * ------------------------------------------------------------------------ */
  const geoData = useMemo(
    () => ({
      type: "FeatureCollection",
      features: buildings.map((b) => ({
        type: "Feature",
        geometry: b.geometry,
        properties: { __id: b.id, __name: b.name },
      })),
    }),
    [buildings]
  );
  const geoKey = useMemo(
    () => `${geoRev}|${heatMode}|${buildings.map((b) => b.id + ":" + b.name).join(";")}`,
    [geoRev, heatMode, buildings]
  );

  // Стиль контуру: колір — за активним планом (getDisplayCategory), а в режимі «Поверховість»
  // насиченість заливки залежить від кількості поверхів
  const featureStyle = (feature) => {
    const b = byId.get(feature.properties.__id);
    if (!b) return {};
    const cat = getCat(getDisplayCategory(b.categories, filter));
    const isSel = b.id === selectedId;
    const isHover = b.id === hoveredId;
    const isVisible = visibleIds.has(b.id);

    let fill;
    if (!isVisible) fill = 0.04;
    else if (heatMode) fill = b.kind === "building" ? getFloorFill(b.floors) : 0.25; // поверховість є лише в будинків
    else fill = Math.max(isSel ? 0.6 : isHover ? 0.55 : 0.32, cat.minFill ?? 0); // minFill — щоб світлий колір було видно

    return {
      color: isSel ? "#111827" : cat.stroke, // контур
      weight: isSel ? 4 : isHover ? 3.5 : 1.8,
      opacity: isVisible ? 1 : 0.25,
      fillColor: cat.color, // заливка
      fillOpacity: fill,
      dashArray: cat.dash,
    };
  };

  // Вибраний контур — поверх решти
  useEffect(() => {
    if (!selectedId || !geoRef.current) return;
    geoRef.current.eachLayer((layer) => {
      if (layer.feature?.properties?.__id === selectedId && layer.bringToFront) layer.bringToFront();
    });
  }, [selectedId, geoKey]);

  /* ------------------------------------------------------------------------
   *  Вибір будинку
   * ------------------------------------------------------------------------ */
  const selectBuilding = (id) => {
    setSelectedId(id);
    setFocusTick((t) => t + 1);
    setPopup(null);
  };

  // Події GeoJSON-шару: подія з конкретного контуру приходить у e.propagatedFrom
  const geoEvents = {
    mouseover: (e) => setHoveredId(e.propagatedFrom?.feature?.properties?.__id ?? null),
    mouseout: () => setHoveredId(null),
    click: (e) => {
      if (placingId || drawing) return; // у режимах переміщення / креслення клік обробить карта
      L.DomEvent.stopPropagation(e);
      const id = e.propagatedFrom?.feature?.properties?.__id;
      if (!id) return;
      setSelectedId(id); // одразу обираємо → бічна панель
      setFocusTick((t) => t + 1);
      setPopup({ id, latlng: e.latlng, stamp: Date.now() });
    },
  };

  /* ------------------------------------------------------------------------
   *  Операції над даними: кожна пише прямо в Supabase, а після успіху
   *  перезавантажує список (fetchBuildings). При помилці — alert.
   * ------------------------------------------------------------------------ */
  // Початок креслення: тип обрано в меню «Додати об'єкт»; далі — клік за кліком по карті
  const startDrawing = (kind) => {
    if (!canEdit) {
      setLoginOpen(true); // гість → пропонуємо увійти
      return;
    }
    setSelectedId(null);
    setPopup(null);
    setPlacingId(null);
    setDrawing({ kind, points: [] });
  };
  const addPoint = (pt) => setDrawing((d) => (d ? { ...d, points: [...d.points, pt] } : d));
  const undoPoint = () => setDrawing((d) => (d ? { ...d, points: d.points.slice(0, -1) } : d));
  const cancelDrawing = () => setDrawing(null);

  // Завершення: замикаємо контур → GeoJSON Polygon → форма полів для обраного типу
  const finishDrawing = () => {
    if (!drawing) return;
    if (drawing.points.length < 3) {
      alert("Для контуру потрібно щонайменше 3 точки.");
      return;
    }
    setForm({
      ...EMPTY_FORM,
      kind: drawing.kind,
      categories: [KINDS[drawing.kind].category],
      geometry: pointsToPolygon(drawing.points),
    });
    setDrawing(null);
    setModalOpen(true);
  };

  const openEdit = (b) => {
    if (!canEdit) return;
    setForm({
      ...EMPTY_FORM,
      id: b.id,
      dbId: b.dbId,
      kind: b.kind,
      name: b.name,
      number: b.number || "",
      categories: b.categories?.length ? b.categories : ["residential"],
      status: b.status || "",
      description: b.description || "",
      floors: b.floors ?? "",
      entrances: b.entrances ?? "",
      apartments: b.apartments ?? "",
      photos: b.photos || [],
      capacity: b.capacity ?? "",
      parkingType: b.parkingType || "open",
      zoneType: b.zoneType || "park",
      amenities: b.amenities || [],
    });
    setModalOpen(true);
  };

  const saveForm = async (e) => {
    e.preventDefault();
    if (!canEdit || saving || !form.name.trim()) return;

    const kind = form.kind || "building";
    const table = TABLES[kind];

    // Поля залежать від типу об'єкта
    let payload;
    if (kind === "parking") {
      payload = {
        title: form.name.trim(),
        capacity: Number(form.capacity) || 0,
        parking_type: form.parkingType || null,
        address: form.number.trim() || null,
        photos: form.photos || [], // масив посилань (колонка photos text[])
        photo_url: (form.photos || [])[0] || null, // сумісність зі старою колонкою
      };
    } else if (kind === "recreation") {
      payload = {
        title: form.name.trim(),
        zone_type: form.zoneType || null,
        amenities_list: Array.isArray(form.amenities) ? form.amenities : [], // jsonb-масив
        address: form.number.trim() || null,
        photos: form.photos || [], // масив посилань (колонка photos text[])
        photo_url: (form.photos || [])[0] || null, // сумісність зі старою колонкою
      };
    } else {
      if (!form.categories || form.categories.length === 0) {
        alert("Оберіть хоча б одну категорію.");
        return;
      }
      payload = buildDbPayload(
        {
          name: form.name.trim(),
          number: form.number.trim(),
          categories: form.categories || [],
          status: form.status.trim(),
          description: form.description.trim(),
          floors: form.floors,
          entrances: form.entrances,
          apartments: form.apartments,
          photos: form.photos || [],
        },
        dbMeta.current
      );
    }

    // Адреса не має губитись мовчки: якщо в buildings немає колонки address — попереджаємо
    if (
      kind === "building" &&
      form.number.trim() &&
      dbMeta.current.columns &&
      !dbMeta.current.columns.has("address")
    ) {
      alert(
        "У таблиці buildings немає колонки «address», тому адресу неможливо зберегти.\n" +
          "Виконайте в Supabase SQL Editor:\nalter table buildings add column if not exists address text;\n" +
          "потім оновіть сторінку."
      );
      return;
    }

    setSaving(true);
    try {
      let newId = null;

      if (form.id) {
        // РЕДАГУВАННЯ (контур не змінюється)
        console.log(`Відправляємо в Supabase (${table}):`, payload);
        const { data, error } = await supabase.from(table).update(payload).eq("id", form.dbId).select();

        if (error) {
          console.error("Supabase Error:", error);
          alert("Помилка Supabase: " + explainDbError(error));
          return; // форма лишається відкритою
        }
        if (!data || data.length === 0) {
          console.error("Supabase Error: 0 рядків оновлено (RLS або невірний id)", form.dbId);
          alert("Помилка Supabase: жоден рядок не оновлено (перевірте політику RLS для UPDATE).");
          return;
        }
      } else {
        // СТВОРЕННЯ: геометрія — контур, накреслений кліками
        if (!form.geometry) {
          alert("Немає контуру. Накресліть об'єкт на карті ще раз.");
          return;
        }
        const insertPayload = { ...payload, geometry: form.geometry };
        console.log(`Відправляємо в Supabase (${table}):`, insertPayload);
        const { data, error } = await supabase.from(table).insert([insertPayload]).select("id").single();

        if (error) {
          console.error("Supabase Error:", error);
          alert("Помилка Supabase: " + explainDbError(error));
          return;
        }
        newId = `${kind}:${data.id}`;
      }

      alert("Успішно збережено в базі даних!");
      await fetchBuildings(); // перезавантаження з бази
      setModalOpen(false);

      if (newId) {
        setSelectedId(newId);
        setFocusTick((t) => t + 1);
        setPopup(null);
      }
    } catch (err) {
      console.error("Supabase Error:", err);
      alert("Помилка Supabase: " + explainDbError(err));
    } finally {
      setSaving(false);
    }
  };

  const deleteBuilding = async (b) => {
    if (!canEdit) return;
    if (!window.confirm("Видалити цей об'єкт?")) return;
    try {
      const { data, error } = await supabase.from(b.table).delete().eq("id", b.dbId).select("id");
      if (error) {
        alert("Не вдалося видалити: " + explainDbError(error));
        return;
      }
      if (!data || data.length === 0) {
        alert("Об'єкт не видалено: рядок не знайдено або видалення заборонено політикою RLS (DELETE).");
        return;
      }
      await fetchBuildings();
      setSelectedId(null);
      setPopup(null);
    } catch (err) {
      console.error(err);
      alert("Помилка видалення: " + explainDbError(err));
    }
  };

  // Переміщення: зсуваємо геометрію так, щоб центр об'єкта опинився в точці кліку
  const placeBuilding = async (latlng) => {
    const b = byId.get(placingId);
    setPlacingId(null);
    if (!b || !canEdit) return;
    const c = geometryBounds(b.geometry).getCenter();
    const geometry = translateGeometry(b.geometry, latlng.lng - c.lng, latlng.lat - c.lat);
    try {
      const { data, error } = await supabase.from(b.table).update({ geometry }).eq("id", b.dbId).select("id");
      if (error) {
        alert("Не вдалося зберегти нове положення: " + explainDbError(error));
        return;
      }
      if (!data || data.length === 0) {
        alert("Положення не збережено: рядок не знайдено або запис заборонено політикою RLS (UPDATE).");
        return;
      }
      await fetchBuildings();
    } catch (err) {
      console.error(err);
      alert("Помилка переміщення: " + explainDbError(err));
    }
  };

  // Фото: для всіх типів об'єктів — масив посилань у колонці photos (text[] / jsonb).
  // photo_url синхронізується з першим фото (для паркінгів і зон — завжди; для будинків — якщо колонка є).
  const savePhoto = async (b, photos) => {
    const list = photos || [];
    const patch = { photos: list };
    if (b.kind !== "building" || dbMeta.current.columns?.has("photo_url")) patch.photo_url = list[0] || null;
    try {
      const { data, error } = await supabase.from(b.table).update(patch).eq("id", b.dbId).select("id");
      if (error) {
        alert("Не вдалося зберегти фото: " + explainDbError(error));
        return false;
      }
      if (!data || data.length === 0) {
        alert("Фото не збережено: рядок не знайдено або запис заборонено політикою RLS (UPDATE).");
        return false;
      }
      await fetchBuildings();
      return true;
    } catch (err) {
      console.error(err);
      alert("Помилка збереження фото: " + explainDbError(err));
      return false;
    }
  };

  // Кілька файлів одразу: завантаження в Storage → посилання додаються в масив photos
  const addPhotosToSelected = async (files) => {
    if (!canEdit || !selected || uploading) return;
    const list = Array.from(files || []).filter((f) => f.type.startsWith("image/"));
    if (list.length === 0) return;
    setUploading(true);
    try {
      const { urls, errors } = await uploadPhotos(list, selected.kind);
      if (errors.length) alert("Не вдалося завантажити:\n" + errors.join("\n"));
      if (urls.length === 0) return;
      const next = [...(selected.photos || []), ...urls];
      if (await savePhoto(selected, next)) setActivePhoto(next.length - 1);
      else await removeFromStorage(urls); // запис у базу не вдався — прибираємо щойно завантажені файли
    } finally {
      setUploading(false);
    }
  };

  const removePhoto = async (index) => {
    if (!canEdit || !selected) return;
    const removed = (selected.photos || [])[index];
    const next = (selected.photos || []).filter((_, i) => i !== index);
    if (await savePhoto(selected, next)) {
      setActivePhoto(0);
      removeFromStorage([removed]); // best effort: файл більше не потрібен
    }
  };

  /* ========================================================================
   *  РОЗМІТКА (edge-to-edge: w-full h-screen overflow-hidden flex flex-col)
   * ======================================================================== */
  return (
    <div
      className="flex h-screen w-full flex-col overflow-hidden bg-stone-100 text-stone-800"
      style={{ fontFamily: "'Onest', system-ui, sans-serif" }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600;700&display=swap');
        html, body { margin: 0 !important; padding: 0 !important; width: 100%; height: 100%; display: block !important; place-items: unset !important; overflow: hidden; }
        #root { max-width: none !important; width: 100% !important; height: 100% !important; margin: 0 !important; padding: 0 !important; text-align: left !important; }
        .leaflet-container { height: 100%; width: 100%; background: #e7e5e0; font-family: inherit; }
        .leaflet-interactive:focus { outline: none; }
        .leaflet-tooltip { font-weight: 600; border-radius: 6px; }
        .leaflet-popup-content { margin: 12px 14px; }
        .placing .leaflet-container { cursor: crosshair; }
        .dist-label-wrap { background: none; border: none; }
        .dist-label { position: absolute; transform: translate(-50%, -50%); white-space: nowrap; padding: 1px 6px; border-radius: 9999px; background: #fff; border: 1px solid #111827; color: #111827; font: 600 11px/16px 'Onest', system-ui, sans-serif; box-shadow: 0 1px 2px rgba(0,0,0,.15); }
        .dist-label--edited { border-color: #d97706; color: #b45309; }
        .leaflet-marker-icon.leaflet-interactive .dist-label { cursor: pointer; }
        .leaflet-marker-icon.leaflet-interactive:hover .dist-label { background: #fef3c7; }
      `}</style>

      {/* ====================== HEADER ======================
          items-center — усі елементи (логотип, пошук, фільтри, кнопки)
          вирівняні по вертикалі; праворуч — «Додати об'єкт» + вхід/вихід. */}
      <header className="relative z-[1100] flex w-full shrink-0 flex-wrap items-center gap-3 border-b border-stone-300 bg-white px-3 py-2.5">
        <div className="flex items-center gap-2 pr-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#2f5d8a] text-white">
            <MapPin size={20} />
          </span>
          <div className="leading-tight">
            <div className="text-base font-bold">Мій квартал</div>
            <div className="text-xs text-stone-500">інтерактивна карта</div>
          </div>
        </div>

        {/* Пошук */}
        <div className="relative w-full min-w-[200px] sm:w-72">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Назва або номер будинку"
            className="w-full rounded-lg border border-stone-300 bg-stone-50 py-2 pl-9 pr-8 text-sm outline-none focus:border-[#2f5d8a] focus:ring-2 focus:ring-[#2f5d8a]/20"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-700"
              aria-label="Очистити пошук"
            >
              <X size={16} />
            </button>
          )}
          {query.trim() && (
            <ul className="absolute left-0 right-0 top-full mt-1 max-h-60 overflow-auto rounded-lg border border-stone-200 bg-white shadow-lg">
              {visibleList.length === 0 && <li className="px-3 py-2 text-sm text-stone-500">Нічого не знайдено</li>}
              {visibleList.slice(0, 30).map((b) => (
                <li key={b.id}>
                  <button
                    onClick={() => {
                      selectBuilding(b.id);
                      setQuery("");
                    }}
                    className="flex w-full flex-col px-3 py-2 text-left text-sm hover:bg-stone-100"
                  >
                    <span className="font-medium">{b.name}</span>
                    <span className="text-xs text-stone-500">{b.number}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Фільтр категорій (випадаюче меню) */}
        <FilterDropdown value={filter} onChange={setFilter} />

        {/* Тогл розмірів: показати / сховати відстані між будинками (той самий стан, що й перемикач у легенді) */}
        <button
          type="button"
          role="switch"
          aria-checked={showDistances}
          onClick={() => setShowDistances((v) => !v)}
          title="Показати / сховати відстані між будинками"
          className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition ${
            showDistances
              ? "border-[#2f5d8a] bg-[#2f5d8a] text-white"
              : "border-stone-300 bg-white text-stone-700 hover:bg-stone-50"
          }`}
        >
          <Ruler size={16} />
          Розміри
          <span className={`rounded-full px-1.5 text-xs ${showDistances ? "bg-white/25" : "bg-stone-200 text-stone-600"}`}>
            {showDistances ? "увімк." : "вимк."}
          </span>
        </button>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* Гість: клік відкриває вікно входу; авторизований: вибір типу → креслення контуру */}
          <AddObjectMenu canEdit={canEdit} onPick={startDrawing} onNeedLogin={() => setLoginOpen(true)} />
          <AuthPanel
            session={session}
            onLogin={() => setLoginOpen(true)}
            onLogout={() => supabase.auth.signOut()}
          />
        </div>
      </header>

      {load.status === "error" && (
        <div className="flex shrink-0 items-start gap-2 bg-red-50 px-3 py-2 text-sm text-red-700">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>Не вдалося завантажити будинки з Supabase: {load.error}</span>
        </div>
      )}

      {/* ====================== MAIN ====================== */}
      <main className={`flex min-h-0 w-full flex-1 flex-col md:flex-row ${placingId || drawing ? "placing" : ""}`}>
        {/* ---------- КАРТА ---------- */}
        <div className="relative h-[43vh] min-h-[260px] shrink-0 md:h-auto md:min-w-0 md:flex-1">
          <div className="absolute inset-0">
            <MapContainer
              ref={mapRef}
              center={DEFAULT_CENTER}
              zoom={DEFAULT_ZOOM}
              minZoom={3}
              maxZoom={20}
              style={{ height: "100%", width: "100%" }}
            >
              {/* Перемикач підкладок */}
              <LayersControl position="topright">
                <LayersControl.BaseLayer checked name="Стандартна (OpenStreetMap)">
                  <TileLayer
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                    maxNativeZoom={19}
                    maxZoom={20}
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                  />
                </LayersControl.BaseLayer>
                <LayersControl.BaseLayer name="Супутник (Esri World Imagery)">
                  <TileLayer
                    url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                    maxNativeZoom={19}
                    maxZoom={20}
                    attribution="Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community"
                  />
                </LayersControl.BaseLayer>
              </LayersControl>

              {/* Контури будинків (FeatureCollection) */}
              {load.status === "ready" && (
                <GeoJSON
                  key={geoKey}
                  ref={geoRef}
                  data={geoData}
                  style={featureStyle}
                  pointToLayer={(feature, latlng) => L.circleMarker(latlng, { radius: 8 })}
                  onEachFeature={(feature, layer) => layer.bindTooltip(feature.properties.__name, { sticky: true })}
                  eventHandlers={geoEvents}
                />
              )}

              {/* Popup: назва + «Переглянути деталі» */}
              {popup && !placingId && byId.get(popup.id) && (
                <Popup key={popup.stamp} position={popup.latlng} autoPan={false} closeButton={false} minWidth={220} maxWidth={260}>
                  <BuildingPopupContent building={byId.get(popup.id)} activePlan={filter} onDetails={selectBuilding} />
                </Popup>
              )}

              {drawing && (
                <DrawLayer
                  kind={drawing.kind}
                  points={drawing.points}
                  onAdd={addPoint}
                  onUndo={undoPoint}
                  onFinish={finishDrawing}
                  onCancel={cancelDrawing}
                />
              )}

              <ResizeWatcher />

              {showDistances && (
                <DistanceLayer
                  pairs={visiblePairs}
                  overrides={distOverrides}
                  canEdit={canEdit}
                  interactive={!placingId && !drawing}
                  editing={distEditing}
                  setEditing={setDistEditing}
                  onSave={saveDistance}
                  onReset={resetDistance}
                />
              )}
              <FitToData bounds={dataBounds} />
              <FocusOnSelected building={selected} tick={focusTick} />
              <MapClicks
                placing={!!placingId}
                onPlace={placeBuilding}
                onEmptyClick={() => {
                  if (drawing) return;
                  setSelectedId(null);
                  setPopup(null);
                }}
              />
            </MapContainer>
          </div>

          {load.status === "loading" && (
            <div className="absolute left-1/2 top-3 z-[500] flex -translate-x-1/2 items-center gap-2 rounded-full bg-white px-4 py-2 text-sm shadow-lg">
              <Loader2 size={16} className="animate-spin" /> Завантаження будинків…
            </div>
          )}

          {drawing && (
            <div className="absolute left-1/2 top-3 z-[500] flex max-w-[95%] -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-2xl bg-stone-900 px-4 py-2 text-sm text-white shadow-lg">
              <Pencil size={15} />
              <span>
                Креслення: {KINDS[drawing.kind].label} · вершин: {drawing.points.length}
              </span>
              <span className="hidden text-xs text-stone-400 xl:inline">
                клікайте на карті · Enter — завершити · Backspace — назад · Esc — скасувати
              </span>
              <button
                onClick={undoPoint}
                disabled={drawing.points.length === 0}
                className="rounded-md border border-stone-600 px-2.5 py-1 hover:bg-stone-800 disabled:opacity-40"
              >
                Назад
              </button>
              <button
                onClick={finishDrawing}
                disabled={drawing.points.length < 3}
                className="rounded-md bg-white px-3 py-1 font-semibold text-stone-900 disabled:opacity-40"
              >
                Завершити
              </button>
              <button onClick={cancelDrawing} className="underline underline-offset-2">
                Скасувати
              </button>
            </div>
          )}

          {placingId && (
            <div className="absolute left-1/2 top-3 z-[500] flex -translate-x-1/2 items-center gap-3 rounded-full bg-stone-900 px-4 py-2 text-sm text-white shadow-lg">
              <Move size={16} /> Клікніть на карті, куди перемістити об'єкт
              <button onClick={() => setPlacingId(null)} className="underline underline-offset-2">
                Скасувати
              </button>
            </div>
          )}

          {/* Легенда: згортальна; на телефонах за замовчуванням згорнута.
              Кнопка-тогл завжди внизу, список росте вгору й прокручується всередині. */}
          <div className="absolute bottom-6 left-3 z-[500] flex max-w-[calc(100%-1.5rem)] flex-col-reverse items-start gap-1.5">
            <button
              type="button"
              onClick={() => setLegendOpen((v) => !v)}
              aria-expanded={legendOpen}
              aria-controls="map-legend"
              className="flex items-center gap-1.5 rounded-lg bg-white/95 px-3 py-1.5 text-xs font-semibold shadow hover:bg-white"
            >
              <Layers size={14} />
              {legendOpen ? "Сховати легенду" : "Показати легенду"}
              <ChevronDown size={14} className={`transition-transform ${legendOpen ? "" : "rotate-180"}`} />
            </button>
            {legendOpen && (
              <div
                id="map-legend"
                className="max-h-[calc(43vh-4rem)] w-full overflow-y-auto overscroll-contain rounded-lg bg-white/95 p-2.5 text-xs shadow md:max-h-[60vh]"
              >
              <button
                type="button"
                role="switch"
                aria-checked={heatMode}
                onClick={() => setHeatMode((v) => !v)}
                className="mb-2 flex w-full items-center justify-between gap-3 rounded-md border border-stone-200 px-2 py-1.5 font-medium hover:bg-stone-50"
              >
                Підсвітка за поверховістю
                <span className={`relative h-4 w-7 shrink-0 rounded-full transition ${heatMode ? "bg-[#2f5d8a]" : "bg-stone-300"}`}>
                  <span
                    className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${heatMode ? "left-3.5" : "left-0.5"}`}
                  />
                </span>
              </button>
              <button
                type="button"
                role="switch"
                aria-checked={showDistances}
                onClick={() => setShowDistances((v) => !v)}
                className="mb-2 flex w-full items-center justify-between gap-3 rounded-md border border-stone-200 px-2 py-1.5 font-medium hover:bg-stone-50"
              >
                <span className="flex items-center gap-1.5">
                  <Ruler size={14} /> Відстані між будинками
                </span>
                <span className={`relative h-4 w-7 shrink-0 rounded-full transition ${showDistances ? "bg-[#2f5d8a]" : "bg-stone-300"}`}>
                  <span
                    className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${showDistances ? "left-3.5" : "left-0.5"}`}
                  />
                </span>
              </button>
              {showDistances && (
                <div className="-mt-1 mb-2 text-[11px] leading-snug text-stone-500">
                  {canEdit ? "Клік на мітці — змінити значення" : "Увійдіть, щоб редагувати значення"}
                </div>
              )}
              {heatMode && (
                <div className="mb-2 border-b border-stone-200 pb-2">
                  {FLOOR_BANDS.map((band) => (
                    <div key={band.label} className="flex items-center gap-2 py-0.5">
                      <span className="h-3 w-5 rounded-sm bg-stone-700" style={{ opacity: band.fill }} />
                      {band.label}
                    </div>
                  ))}
                </div>
              )}
              {Object.entries(CATEGORIES).map(([key, c]) => (
                <div key={key} className="flex items-center gap-2 py-0.5">
                  <span className="h-3 w-3 rounded-sm" style={{ background: c.color, border: `1.5px solid ${c.stroke}` }} />
                  {c.label}
                </div>
              ))}
              </div>
            )}
          </div>
        </div>

        {/* ---------- БІЧНА ПАНЕЛЬ ---------- */}
        <aside
          ref={asideRef}
          className="min-h-0 w-full flex-1 overflow-y-auto border-t border-stone-300 bg-white md:w-[380px] md:flex-none md:shrink-0 md:border-l md:border-t-0"
        >
          {!selected ? (
            <QuarterOverview
              activePlan={filter}
              buildings={buildings}
              visibleList={visibleList}
              loading={load.status === "loading"}
              onSelect={selectBuilding}
            />
          ) : (
            <BuildingPanel
              activePlan={filter}
              building={selected}
              activePhoto={activePhoto}
              setActivePhoto={setActivePhoto}
              onClose={() => setSelectedId(null)}
              onEdit={() => openEdit(selected)}
              onDelete={() => deleteBuilding(selected)}
              onMove={() => setPlacingId(selected.id)}
              onAddPhoto={addPhotosToSelected}
              uploading={uploading}
              onRemovePhoto={removePhoto}
              canEdit={canEdit}
            />
          )}
        </aside>
      </main>

      {/* ====================== МОДАЛЬНІ ВІКНА ====================== */}
      {loginOpen && !session && <LoginModal onClose={() => setLoginOpen(false)} />}
      {modalOpen && (
        <BuildingModal
          form={form}
          setForm={setForm}
          onSave={saveForm}
          onClose={() => !saving && setModalOpen(false)}
          saving={saving}
        />
      )}
    </div>
  );
}

/* ============================================================================
 *  8. БІЧНА ПАНЕЛЬ: СТАТИСТИКА КВАРТАЛУ + КАРТКИ ОБ'ЄКТІВ
 * ============================================================================ */
function QuarterOverview({ buildings, visibleList, loading, onSelect, activePlan }) {
  const count = (cat) => buildings.filter((b) => b.categories.includes(cat)).length;
  const filtered = visibleList.length !== buildings.length;

  return (
    <div className="p-4">
      <h2 className="text-lg font-bold">Про квартал</h2>
      <p className="mt-1 text-sm text-stone-600">
        Оберіть будинок на карті або в списку, щоб побачити фото, опис і характеристики.
      </p>

      <div className="mt-4 rounded-xl bg-stone-100 p-3">
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-stone-600">Усього об'єктів</span>
          <span className="text-2xl font-bold">{loading ? "…" : buildings.length}</span>
        </div>
        {filtered && (
          <div className="mt-1 text-xs text-stone-500">За поточним пошуком/фільтром: {visibleList.length}</div>
        )}
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        {Object.entries(CATEGORIES).map(([key, c]) => (
          <div key={key} className="flex items-center gap-3 rounded-lg border border-stone-200 p-3">
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-white"
              style={{ background: c.ui }}
            >
              <c.Icon size={18} />
            </span>
            <div className="min-w-0 leading-tight">
              <div className="text-xl font-bold">{count(key)}</div>
              <div className="truncate text-xs text-stone-500" title={c.label}>
                {c.label}
              </div>
            </div>
          </div>
        ))}
      </div>

      <h3 className="mt-6 text-sm font-semibold text-stone-500">Об'єкти</h3>
      {visibleList.length === 0 && !loading && <p className="mt-2 text-sm text-stone-500">Нічого не знайдено.</p>}
      <ul className="mt-2 space-y-2">
        {visibleList.map((b) => {
          const c = getCat(getDisplayCategory(b.categories, activePlan));
          const thumb = b.photos && b.photos[0];
          return (
            <li key={b.id}>
              <button
                onClick={() => onSelect(b.id)}
                className="flex w-full items-center gap-3 rounded-xl border border-stone-200 p-2 text-left transition hover:border-stone-300 hover:bg-stone-50"
              >
                {thumb ? (
                  <img src={thumb} alt="" className="h-14 w-14 shrink-0 rounded-lg object-cover" />
                ) : (
                  <span
                    className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg text-white"
                    style={{ background: c.ui }}
                  >
                    <c.Icon size={22} />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{b.name}</span>
                  {b.number && <span className="block truncate text-xs text-stone-500">{b.number}</span>}
                  <span className="mt-1 flex items-center gap-1.5">
                    <span
                      className="rounded-full px-2 py-0.5 text-[10px] font-semibold text-white"
                      style={{ background: c.ui }}
                    >
                      {c.label}
                    </span>
                    {b.status && <span className="truncate text-[11px] text-stone-500">{b.status}</span>}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ============================================================================
 *  9. БІЧНА ПАНЕЛЬ: ІНФОРМАЦІЯ ПРО БУДИНОК
 * ============================================================================ */
function BuildingPanel({
  building: b,
  activePlan,
  activePhoto,
  setActivePhoto,
  onClose,
  onEdit,
  onDelete,
  onMove,
  onAddPhoto,
  onRemovePhoto,
  canEdit,
  uploading,
}) {
  const fileRef = useRef(null);
  const cat = getCat(getDisplayCategory(b.categories, activePlan));
  const photos = b.photos || [];
  const features = b.features || [];
  const idx = photos.length ? Math.min(activePhoto, photos.length - 1) : 0;
  const main = photos[idx];
  const go = (step) => setActivePhoto((idx + step + photos.length) % photos.length);

  const isBuilding = b.kind === "building";
  const showImage = isBuilding || photos.length > 0; // паркінг / зона без фото → компактна шапка

  return (
    <div>
      {!showImage && (
        <div className="flex items-center justify-between border-b border-stone-200 bg-stone-50 px-4 py-3">
          <span className="text-xs font-semibold uppercase tracking-wide text-stone-500">{KINDS[b.kind].label}</span>
          <button onClick={onClose} className="rounded-full p-1.5 text-stone-500 hover:bg-stone-200" aria-label="Закрити">
            <X size={16} />
          </button>
        </div>
      )}
      {showImage && (
      <div className="relative aspect-[4/3] bg-stone-200">
        {main ? (
          <img src={main} alt={`${b.name} — фото ${idx + 1}`} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-stone-400">
            <ImagePlus size={32} />
            <span className="text-sm">Фото ще немає</span>
          </div>
        )}

        {photos.length > 1 && (
          <>
            <button
              onClick={() => go(-1)}
              className="absolute left-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-full bg-white/90 py-1.5 pl-1.5 pr-2.5 text-xs font-medium shadow hover:bg-white"
              aria-label="Назад"
            >
              <ChevronLeft size={16} /> Назад
            </button>
            <button
              onClick={() => go(1)}
              className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-full bg-white/90 py-1.5 pl-2.5 pr-1.5 text-xs font-medium shadow hover:bg-white"
              aria-label="Вперед"
            >
              Вперед <ChevronRight size={16} />
            </button>
            <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-2.5 py-0.5 text-xs text-white">
              {idx + 1} / {photos.length}
            </span>
          </>
        )}

        {canEdit && photos.length === 1 && (
          <button
            onClick={() => onRemovePhoto(0)}
            className="absolute bottom-2 right-2 flex items-center gap-1 rounded-full bg-white/90 px-2.5 py-1 text-xs font-medium text-red-600 shadow hover:bg-white"
          >
            <Trash2 size={13} /> Видалити фото
          </button>
        )}

        <button
          onClick={onClose}
          className="absolute right-3 top-3 rounded-full bg-white/90 p-1.5 shadow hover:bg-white"
          aria-label="Закрити"
        >
          <X size={16} />
        </button>
      </div>
      )}

      {/* Галерея: сітка мініатюр усіх фото (клік — показати велике) */}
      {photos.length > 1 && (
        <div className="px-4 pb-1 pt-3">
          <div className="mb-1.5 text-xs font-semibold text-stone-500">Фотографії ({photos.length})</div>
          <div className="grid grid-cols-4 gap-2">
            {photos.map((p, i) => (
              <div key={i} className="relative aspect-square">
                <button onClick={() => setActivePhoto(i)} aria-label={`Фото ${i + 1}`} className="h-full w-full">
                  <img
                    src={p}
                    alt=""
                    loading="lazy"
                    className={`h-full w-full rounded-md object-cover ${
                      i === idx ? "ring-2 ring-[#2f5d8a]" : "opacity-70 hover:opacity-100"
                    }`}
                  />
                </button>
                {canEdit && (
                  <button
                    onClick={() => onRemovePhoto(i)}
                    className="absolute -right-1 -top-1 rounded-full bg-red-600 p-0.5 text-white"
                    aria-label="Видалити фото"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-stone-500">Категорії:</span>
          {CATEGORY_PRIORITY.filter((k) => b.categories.includes(k)).map((k) => {
            const c = CATEGORIES[k];
            return (
              <span
                key={k}
                className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold text-white"
                style={{ background: c.ui }}
              >
                <c.Icon size={12} /> {c.label}
              </span>
            );
          })}
          {b.status && <span className="rounded-full bg-stone-100 px-2.5 py-0.5 text-xs text-stone-600">{b.status}</span>}
        </div>

        <h2 className="mt-2 text-xl font-bold leading-snug">{b.name}</h2>
        {b.number && <p className="text-sm text-stone-500">{b.number}</p>}
        {b.description && <p className="mt-3 text-sm leading-relaxed text-stone-700">{b.description}</p>}

        {features.length > 0 && (
          <>
            <h3 className="mt-5 text-sm font-semibold text-stone-500">Характеристики</h3>
            <ul className="mt-2 space-y-1.5 text-sm">
              {features.map((f, i) => (
                <li key={i} className="flex gap-2">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: cat.ui }} />
                  {f}
                </li>
              ))}
            </ul>
          </>
        )}

        {/* Кнопки редагування — тільки для авторизованих */}
        {canEdit && (
          <>
          <div className="mt-6 grid grid-cols-2 gap-2">
            <button
              onClick={onEdit}
              className="flex items-center justify-center gap-1.5 rounded-lg bg-[#2f5d8a] px-3 py-2 text-sm font-semibold text-white hover:bg-[#264d73]"
            >
              <Pencil size={15} /> Редагувати
            </button>
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="flex items-center justify-center gap-1.5 rounded-lg border border-stone-300 px-3 py-2 text-sm font-semibold hover:bg-stone-50 disabled:opacity-60"
            >
              {uploading ? <Loader2 size={15} className="animate-spin" /> : <ImagePlus size={15} />}
              {uploading ? "Завантаження…" : "Додати фото"}
            </button>
            <button
              onClick={onMove}
              className="flex items-center justify-center gap-1.5 rounded-lg border border-stone-300 px-3 py-2 text-sm hover:bg-stone-50"
            >
              <Move size={15} /> Перемістити
            </button>
            <button
              onClick={onDelete}
              className="flex items-center justify-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
            >
              <Trash2 size={15} /> Видалити
            </button>
          </div>

          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              onAddPhoto(e.target.files);
              e.target.value = "";
            }}
          />
          </>
        )}
      </div>
    </div>
  );
}

/* ============================================================================
 *  10. МОДАЛЬНЕ ВІКНО: ДОДАТИ / РЕДАГУВАТИ ОБ'ЄКТ
 * ============================================================================ */
function BuildingModal({ form, setForm, onSave, onClose, saving }) {
  const fileRef = useRef(null);
  const [url, setUrl] = useState("");
  const [amenityInput, setAmenityInput] = useState("");
  const [uploading, setUploading] = useState(false); // триває завантаження файлів у Storage
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const toggleCategory = (key) =>
    setForm((f) => {
      const cur = f.categories || [];
      return { ...f, categories: cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key] };
    });

  const toggleAmenity = (name) =>
    setForm((f) => {
      const cur = f.amenities || [];
      return { ...f, amenities: cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name] };
    });
  const addAmenity = () => {
    const v = amenityInput.trim();
    if (!v) return;
    setForm((f) => ({ ...f, amenities: [...new Set([...(f.amenities || []), v])] }));
    setAmenityInput("");
  };

  // Можна вставити одне або кілька посилань (через пробіл, кому чи новий рядок)
  const addUrl = () => {
    const urls = url
      .split(/[\s,]+/)
      .map((u) => u.trim())
      .filter(Boolean);
    if (urls.length === 0) return;
    const bad = urls.filter((u) => !/^(https?:\/\/|data:image\/)/i.test(u));
    if (bad.length) {
      alert("Посилання має починатися з http:// або https://:\n" + bad.join("\n"));
      return;
    }
    setForm((f) => ({ ...f, photos: [...new Set([...(f.photos || []), ...urls])] }));
    setUrl("");
  };

  // Кілька файлів одразу → Supabase Storage → посилання додаються у form.photos
  const addFiles = async (files) => {
    const list = Array.from(files || []).filter((f) => f.type.startsWith("image/"));
    if (list.length === 0) return;
    setUploading(true);
    try {
      const { urls, errors } = await uploadPhotos(list, form.kind || "building");
      if (urls.length) setForm((f) => ({ ...f, photos: [...new Set([...(f.photos || []), ...urls])] }));
      if (errors.length) alert("Не вдалося завантажити:\n" + errors.join("\n"));
    } finally {
      setUploading(false);
    }
  };

  const inputCls =
    "w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-[#2f5d8a] focus:ring-2 focus:ring-[#2f5d8a]/20";

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <form
        onSubmit={onSave}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">
            {form.id ? "Редагувати" : "Новий"}: {KINDS[form.kind || "building"].label.toLowerCase()}
          </h2>
          <button type="button" onClick={onClose} aria-label="Закрити" className="text-stone-400 hover:text-stone-800">
            <X size={20} />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <label className="block text-sm font-medium">
            Назва *
            <input required value={form.name} onChange={set("name")} className={`${inputCls} mt-1`} placeholder={
                form.kind === "parking"
                  ? "Наприклад, Підземний паркінг"
                  : form.kind === "recreation"
                  ? "Наприклад, Сквер ім. Шевченка"
                  : "Наприклад, Будинок 12"
              }
            />
          </label>

          {/* Адреса — повноцінне текстове поле для будь-якого типу об'єкта (зберігається в колонку address) */}
          <label className="block text-sm font-medium">
            Адреса
            <input
              type="text"
              name="address"
              autoComplete="street-address"
              value={form.number}
              onChange={set("number")}
              className={`${inputCls} mt-1`}
              placeholder="вул. Дмитра Яворницького, 12"
            />
          </label>

          {form.kind === "parking" && (
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm font-medium">
                Кількість машиномісць
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={form.capacity}
                  onChange={set("capacity")}
                  className={`${inputCls} mt-1`}
                  placeholder="120"
                />
              </label>
              <label className="block text-sm font-medium">
                Тип паркінгу
                <select value={form.parkingType} onChange={set("parkingType")} className={`${inputCls} mt-1`}>
                  {Object.entries(PARKING_TYPES).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {form.kind === "recreation" && (
            <>
              <label className="block text-sm font-medium">
                Тип зони
                <select value={form.zoneType} onChange={set("zoneType")} className={`${inputCls} mt-1`}>
                  {Object.entries(ZONE_TYPES).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>

              <fieldset>
                <legend className="text-sm font-medium">Благоустрій</legend>
                <div className="mt-1 grid grid-cols-2 gap-2">
                  {[...new Set([...AMENITIES, ...(form.amenities || [])])].map((a) => {
                    const checked = (form.amenities || []).includes(a);
                    return (
                      <label
                        key={a}
                        className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                          checked ? "border-[#2E7D32] bg-[#4CAF50]/10" : "border-stone-300 hover:bg-stone-50"
                        }`}
                      >
                        <input type="checkbox" checked={checked} onChange={() => toggleAmenity(a)} className="h-4 w-4" />
                        {a}
                      </label>
                    );
                  })}
                </div>
                <div className="mt-2 flex gap-2">
                  <input
                    value={amenityInput}
                    onChange={(e) => setAmenityInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addAmenity();
                      }
                    }}
                    placeholder="Свій елемент благоустрою"
                    className={inputCls}
                  />
                  <button
                    type="button"
                    onClick={addAmenity}
                    className="flex shrink-0 items-center gap-1 rounded-lg border border-stone-300 px-3 text-sm hover:bg-stone-50"
                  >
                    <Plus size={14} /> Додати
                  </button>
                </div>
              </fieldset>
            </>
          )}

          {(form.kind || "building") === "building" && (
            <>

          <fieldset>
            <legend className="text-sm font-medium">Категорії (можна кілька)</legend>
            <div className="mt-1 grid grid-cols-2 gap-2">
              {CATEGORY_PRIORITY.map((k) => {
                const c = CATEGORIES[k];
                const checked = (form.categories || []).includes(k);
                return (
                  <label
                    key={k}
                    className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                      checked ? "border-[#2f5d8a] bg-[#2f5d8a]/5" : "border-stone-300 hover:bg-stone-50"
                    }`}
                  >
                    <input type="checkbox" checked={checked} onChange={() => toggleCategory(k)} className="h-4 w-4" />
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: c.color, border: `1.5px solid ${c.stroke}` }} />
                    {c.label}
                  </label>
                );
              })}
            </div>
            {(form.categories || []).length === 0 && (
              <p className="mt-1 text-xs text-red-600">Оберіть хоча б одну категорію.</p>
            )}
            <p className="mt-1 text-xs text-stone-500">
              Колір на карті — за найвищим пріоритетом: Житлові → Комерція → Громадські → Рекреація → Паркінг → Технічні.
            </p>
          </fieldset>

          <label className="block text-sm font-medium">
            Статус
            <input value={form.status} onChange={set("status")} className={`${inputCls} mt-1`} placeholder="Заселений" />
          </label>

          <label className="block text-sm font-medium">
            Опис
            <textarea rows={3} value={form.description} onChange={set("description")} className={`${inputCls} mt-1`} />
          </label>

          <div className="grid grid-cols-3 gap-3">
            <label className="block text-sm font-medium">
              Поверхів
              <input
                type="number"
                min="1"
                step="1"
                value={form.floors}
                onChange={set("floors")}
                className={`${inputCls} mt-1`}
                placeholder="9"
              />
            </label>
            <label className="block text-sm font-medium">
              Під'їздів
              <input
                type="number"
                min="1"
                step="1"
                value={form.entrances}
                onChange={set("entrances")}
                className={`${inputCls} mt-1`}
                placeholder="4"
              />
            </label>
            <label className="block text-sm font-medium">
              Квартир
              <input
                type="number"
                min="0"
                step="1"
                value={form.apartments}
                onChange={set("apartments")}
                className={`${inputCls} mt-1`}
                placeholder="144"
              />
            </label>
          </div>

            </>
          )}

          <div>
            <div className="text-sm font-medium">Фото (можна вибрати кілька; перше — головне)</div>
            {(form.photos || []).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {form.photos.map((p, i) => (
                  <div key={i} className="relative">
                    <img src={p} alt="" className="h-16 w-16 rounded-md object-cover" />
                    <button
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, photos: f.photos.filter((_, j) => j !== i) }))}
                      className="absolute -right-1 -top-1 rounded-full bg-red-600 p-0.5 text-white"
                      aria-label="Видалити фото"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-2 flex gap-2">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addUrl();
                  }
                }}
                placeholder="https://… одне або кілька посилань"
                className={inputCls}
              />
              <button type="button" onClick={addUrl} className="flex shrink-0 items-center gap-1 rounded-lg border border-stone-300 px-3 text-sm hover:bg-stone-50">
                <LinkIcon size={14} /> Додати
              </button>
            </div>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="mt-2 flex items-center gap-1.5 text-sm font-medium text-[#2f5d8a] hover:underline disabled:opacity-60"
            >
              {uploading ? <Loader2 size={15} className="animate-spin" /> : <ImagePlus size={15} />}
              {uploading ? "Завантаження файлів…" : "Вибрати файли (можна кілька)"}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>


          {!form.id && (
            <p className="rounded-lg bg-stone-100 p-3 text-xs text-stone-600">
              Контур уже накреслено на карті — після збереження об'єкт з'явиться на ній.
            </p>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-lg border border-stone-300 px-4 py-2 text-sm hover:bg-stone-50 disabled:opacity-60"
          >
            Скасувати
          </button>
          <button
            type="submit"
            disabled={saving || uploading}
            className="flex items-center gap-1.5 rounded-lg bg-[#2f5d8a] px-4 py-2 text-sm font-semibold text-white hover:bg-[#264d73] disabled:opacity-60"
          >
            {saving && <Loader2 size={15} className="animate-spin" />}
            {form.id ? "Зберегти зміни" : "Додати на карту"}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ============================================================================
 *  11. МОДАЛЬНЕ ВІКНО: ВХІД В АКАУНТ (Supabase Auth)
 * ============================================================================ */
function LoginModal({ onClose }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) setError(error.message);
    // Успіх: onAuthStateChange в App оновить сесію й закриє це вікно
  };

  const inputCls =
    "mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-[#1d4ed8] focus:ring-2 focus:ring-[#1d4ed8]/20";

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl"
      >
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <LogIn size={20} className="text-[#1d4ed8]" /> Вхід в акаунт
          </h2>
          <button type="button" onClick={onClose} aria-label="Закрити" className="text-stone-400 hover:text-stone-800">
            <X size={20} />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <label className="block text-sm font-medium">
            Email
            <input
              type="email"
              required
              autoFocus
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputCls}
              placeholder="you@example.com"
            />
          </label>
          <label className="block text-sm font-medium">
            Password
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputCls}
            />
          </label>
          {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-stone-300 px-4 py-2 text-sm hover:bg-stone-50">
            Скасувати
          </button>
          <button
            type="submit"
            disabled={busy}
            className="flex items-center gap-1.5 rounded-lg bg-[#1d4ed8] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1e40af] disabled:opacity-60"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <LogIn size={15} />}
            Увійти
          </button>
        </div>
      </form>
    </div>
  );
}
