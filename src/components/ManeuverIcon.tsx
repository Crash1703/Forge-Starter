import type { ManeuverKind } from "../lib/navigation";

/** Turn arrows for the Ride screen, drawn to read at a glance on a bar mount. */
export default function ManeuverIcon({ kind, size = 56 }: { kind: ManeuverKind; size?: number }) {
  const mirror = kind === "left" || kind === "slight-left" || kind === "sharp-left";
  const shape = mirror ? kind.replace("left", "right") : kind;
  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      className="maneuver"
      aria-hidden="true"
      style={mirror ? { transform: "scaleX(-1)" } : undefined}
    >
      {PATHS[shape as keyof typeof PATHS] ?? PATHS.straight}
    </svg>
  );
}

const PATHS = {
  straight: (
    <>
      <path d="M24 44 V9" />
      <path d="M13 19 L24 8 L35 19" />
    </>
  ),
  depart: (
    <>
      <circle cx="24" cy="40" r="4" className="fill" />
      <path d="M24 36 V9" />
      <path d="M13 19 L24 8 L35 19" />
    </>
  ),
  right: (
    <>
      <path d="M15 44 V26 Q15 17 24 17 H38" />
      <path d="M29 8 L38 17 L29 26" />
    </>
  ),
  "slight-right": (
    <>
      <path d="M17 44 V30 L35 12" />
      <path d="M22 11 H36 V25" />
    </>
  ),
  "sharp-right": (
    <>
      <path d="M15 44 V14 Q15 7 22 12 L36 30" />
      <path d="M37 18 V31 H24" />
    </>
  ),
  uturn: (
    <>
      <path d="M32 44 V18 Q32 8 23 8 Q14 8 14 18 V34" />
      <path d="M6 27 L14 35 L22 27" />
    </>
  ),
  // In from below, round the ring clockwise (as Australian roundabouts go),
  // out at the top; the rest of the ring faint. (The exit number is in the
  // text beside it.) The old one, a ring with an arrow off it, looked like ♂.
  roundabout: (
    <>
      <path d="M24 13 A10 10 0 0 1 24 33" opacity="0.35" />
      <path d="M24 45 V33 A10 10 0 0 1 24 13 V5" />
      <path d="M17 11 L24 4 L31 11" />
    </>
  ),
  merge: (
    <>
      <path d="M14 44 V34 L24 22 V9" />
      <path d="M34 44 V34 L27 26" />
      <path d="M13 19 L24 8 L35 19" />
    </>
  ),
  arrive: (
    <>
      <path d="M15 44 V7" />
      <path d="M15 8 H35 L29 15 L35 22 H15" className="fill" />
    </>
  ),
  stop: (
    <>
      <path d="M24 44 C24 44 11 30 11 20 A13 13 0 0 1 37 20 C37 30 24 44 24 44 Z" />
      <circle cx="24" cy="20" r="4.5" className="fill" />
    </>
  ),
  ferry: (
    <>
      <path d="M8 30 H40 L35 40 H13 Z" />
      <path d="M16 30 V20 H32 V30" />
      <path d="M24 20 V11" />
    </>
  ),
};
