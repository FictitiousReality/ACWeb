import type { BinReader } from "../reader.ts";

export interface LandDefs {
  numBlockLength: number;
  numBlockWidth: number;
  squareLength: number;
  lblockLength: number;
  vertexPerCell: number;
  maxObjHeight: number;
  skyHeight: number;
  roadWidth: number;
  landHeightTable: Float32Array;
}

export interface TerrainAlphaMap {
  tcode: number;
  texGID: number;
}
export interface RoadAlphaMap {
  rcode: number;
  roadTexGID: number;
}
export interface TerrainTex {
  texGID: number;
  texTiling: number;
  maxVertBright: number;
  minVertBright: number;
  maxVertSaturate: number;
  minVertSaturate: number;
  maxVertHue: number;
  minVertHue: number;
  detailTexTiling: number;
  detailTexGID: number;
}
export interface TexMerge {
  baseTexSize: number;
  cornerTerrainMaps: TerrainAlphaMap[];
  sideTerrainMaps: TerrainAlphaMap[];
  roadMaps: RoadAlphaMap[];
  terrainDesc: { terrainType: number; terrainTex: TerrainTex }[];
}
export interface TerrainType {
  name: string;
  color: number;
  sceneTypes: number[];
}
export interface SkyTimeOfDay {
  begin: number;
  dirBright: number;
  dirHeading: number;
  dirPitch: number;
  dirColor: number;
  ambBright: number;
  ambColor: number;
  minWorldFog: number;
  maxWorldFog: number;
  worldFogColor: number;
  worldFog: number;
  skyObjReplace: { objectIndex: number; gfxObjId: number; rotate: number; transparent: number; luminosity: number; maxBright: number }[];
}
export interface DayGroup {
  chanceOfOccur: number;
  dayName: string;
  skyObjects: {
    beginTime: number; endTime: number; beginAngle: number; endAngle: number;
    texVelocityX: number; texVelocityY: number; defaultGfxObjectId: number; defaultPESObjectId: number; properties: number;
  }[];
  skyTime: SkyTimeOfDay[];
}

/** 0x13000000: the one region descriptor (Dereth). */
export interface RegionDesc {
  id: number;
  regionNumber: number;
  version: number;
  regionName: string;
  landDefs: LandDefs;
  gameTime: {
    zeroTimeOfYear: number; zeroYear: number; dayLength: number; daysPerYear: number; yearSpec: string;
    timesOfDay: { start: number; isNight: boolean; name: string }[];
    daysOfTheWeek: string[];
    seasons: { startDate: number; name: string }[];
  };
  partsMask: number;
  sky?: { tickSize: number; lightTickSize: number; dayGroups: DayGroup[] };
  sound?: { stbId: number; ambientSounds: { sType: number; volume: number; baseChance: number; minRate: number; maxRate: number }[] }[];
  scene?: { stbIndex: number; scenes: number[] }[];
  terrainTypes: TerrainType[];
  landSurfType: number;
  texMerge: TexMerge;
  misc?: { version: number; gameMapId: number; autotestMapId: number; autotestMapSize: number; clearCellId: number; clearMonsterId: number };
}

function alignedPString(r: BinReader): string {
  const s = r.pstring();
  r.align();
  return s;
}

export function parseRegion(r: BinReader): RegionDesc {
  const id = r.u32();
  const regionNumber = r.u32();
  const version = r.u32();
  const regionName = alignedPString(r);

  const landDefs: LandDefs = {
    numBlockLength: r.i32(),
    numBlockWidth: r.i32(),
    squareLength: r.f32(),
    lblockLength: r.i32(),
    vertexPerCell: r.i32(),
    maxObjHeight: r.f32(),
    skyHeight: r.f32(),
    roadWidth: r.f32(),
    landHeightTable: new Float32Array(256),
  };
  for (let i = 0; i < 256; i++) landDefs.landHeightTable[i] = r.f32();

  const gameTime = {
    zeroTimeOfYear: r.f64(),
    zeroYear: r.u32(),
    dayLength: r.f32(),
    daysPerYear: r.u32(),
    yearSpec: alignedPString(r),
    timesOfDay: r.list((rr) => ({ start: rr.f32(), isNight: rr.u32() === 1, name: alignedPString(rr) })),
    daysOfTheWeek: r.list(alignedPString),
    seasons: r.list((rr) => ({ startDate: rr.u32(), name: alignedPString(rr) })),
  };

  const partsMask = r.u32();
  const out: RegionDesc = {
    id, regionNumber, version, regionName, landDefs, gameTime, partsMask,
    terrainTypes: [], landSurfType: 0,
    texMerge: { baseTexSize: 0, cornerTerrainMaps: [], sideTerrainMaps: [], roadMaps: [], terrainDesc: [] },
  };

  if (partsMask & 0x10) {
    const tickSize = r.f64();
    const lightTickSize = r.f64();
    r.align();
    const dayGroups = r.list((rr): DayGroup => ({
      chanceOfOccur: rr.f32(),
      dayName: alignedPString(rr),
      skyObjects: rr.list((s) => {
        const o = {
          beginTime: s.f32(), endTime: s.f32(), beginAngle: s.f32(), endAngle: s.f32(),
          texVelocityX: s.f32(), texVelocityY: s.f32(),
          defaultGfxObjectId: s.u32(), defaultPESObjectId: s.u32(), properties: s.u32(),
        };
        s.align();
        return o;
      }),
      skyTime: rr.list((s): SkyTimeOfDay => {
        const t = {
          begin: s.f32(), dirBright: s.f32(), dirHeading: s.f32(), dirPitch: s.f32(), dirColor: s.u32(),
          ambBright: s.f32(), ambColor: s.u32(), minWorldFog: s.f32(), maxWorldFog: s.f32(),
          worldFogColor: s.u32(), worldFog: s.u32(),
        };
        s.align();
        const skyObjReplace = s.list((q) => {
          const rep = {
            objectIndex: q.u32(), gfxObjId: q.u32(), rotate: q.f32(), transparent: q.f32(),
            luminosity: q.f32(), maxBright: q.f32(),
          };
          q.align();
          return rep;
        });
        return { ...t, skyObjReplace };
      }),
    }));
    out.sky = { tickSize, lightTickSize, dayGroups };
  }

  if (partsMask & 0x01) {
    out.sound = r.list((rr) => ({
      stbId: rr.u32(),
      ambientSounds: rr.list((s) => ({ sType: s.u32(), volume: s.f32(), baseChance: s.f32(), minRate: s.f32(), maxRate: s.f32() })),
    }));
  }

  if (partsMask & 0x02) {
    out.scene = r.list((rr) => ({ stbIndex: rr.u32(), scenes: rr.u32List() }));
  }

  // TerrainDesc
  out.terrainTypes = r.list((rr): TerrainType => ({ name: alignedPString(rr), color: rr.u32(), sceneTypes: rr.u32List() }));
  out.landSurfType = r.u32();
  if (out.landSurfType === 1) throw new Error("PalShift land surfaces not supported");
  const alpha = (rr: BinReader): TerrainAlphaMap => ({ tcode: rr.u32(), texGID: rr.u32() });
  out.texMerge = {
    baseTexSize: r.u32(),
    cornerTerrainMaps: r.list(alpha),
    sideTerrainMaps: r.list(alpha),
    roadMaps: r.list((rr): RoadAlphaMap => ({ rcode: rr.u32(), roadTexGID: rr.u32() })),
    terrainDesc: r.list((rr) => ({
      terrainType: rr.u32(),
      terrainTex: {
        texGID: rr.u32(), texTiling: rr.u32(), maxVertBright: rr.u32(), minVertBright: rr.u32(),
        maxVertSaturate: rr.u32(), minVertSaturate: rr.u32(), maxVertHue: rr.u32(), minVertHue: rr.u32(),
        detailTexTiling: rr.u32(), detailTexGID: rr.u32(),
      },
    })),
  };

  if (partsMask & 0x200) {
    out.misc = {
      version: r.u32(), gameMapId: r.u32(), autotestMapId: r.u32(), autotestMapSize: r.u32(),
      clearCellId: r.u32(), clearMonsterId: r.u32(),
    };
  }
  return out;
}
