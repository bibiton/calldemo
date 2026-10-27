export interface ManifestFile {
  key: string;
  text: string;
  file: string;
  category: string;
  pack?: string;
  tags?: string[];
  venue?: "any" | "food";
  defaultEnabled?: boolean;
  manualOnly?: boolean;
  durationSec?: number;
}

export interface Manifest {
  version: number;
  gapsMs: {
    afterChime: number;
    prefixToNumber: number;
    letterToNumber: number;
    numberToEnding: number;
    recallToPrefix: number;
    betweenRepeats: number;
  };
  rules: {
    number: {
      combined: { letters: string; range: [number, number]; file: string };
      fallback: { letterFile: string; numberFile: string; gapMs: number };
    };
    counter: { range: [number, number] };
    [k: string]: unknown;
  };
  prefixPacks: { key: string; name: string; prefixKeys: string[] }[];
  files: ManifestFile[];
}

export interface Segment {
  key: string;
  url: string;
  gapBeforeMs: number;
}

export interface CallItem {
  ticketId: string;
  number: string;
  counterNo: number | null;
  kind: "call" | "recall" | "skipped";
}

export interface Plan {
  item: CallItem;
  segments: Segment[];
  text: string;
  prefixKey: string;
  speechOnly: boolean;
}
