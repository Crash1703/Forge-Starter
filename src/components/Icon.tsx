/**
 * Line icons, drawn on a 24×24 grid in the text colour, so they look the same
 * on every phone (emoji differ by maker and look out of place in the UI).
 */
const PATHS = {
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
  layers: "M12 3 2 8l10 5 10-5-10-5zM2 13l10 5 10-5M2 17.5l10 5 10-5",
  locate: "M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM12 2v3M12 19v3M2 12h3M19 12h3M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  loop: "M20 11a8 8 0 0 0-14.3-4.9L4 8M4 3v5h5M4 13a8 8 0 0 0 14.3 4.9L20 16M20 21v-5h-5",
  plus: "M12 5v14M5 12h14",
  plusCircle: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8v8M8 12h8",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  flag: "M5 21V4M5 4h11l-2 4 2 4H5",
  pin: "M12 21s-6-5.7-6-11a6 6 0 1 1 12 0c0 5.3-6 11-6 11zM12 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  map: "M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14",
  settings:
    "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  fuel: "M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3 21h12M4 10h10M14 13h2a2 2 0 0 1 2 2v2a1.5 1.5 0 0 0 3 0V9l-3-3",
  food: "M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M17 21V3c-2 1-3 4-3 7h3",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  toilet: "M7 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM17 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM5 21v-6H4l1.5-6h3L10 15H9v6M15 21V9h4v12M12 3v18",
  pause: "M8 5v14M16 5v14",
  play: "M7 4l13 8-13 8V4z",
  volume: "M4 9v6h4l5 4V5L8 9H4zM16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12",
  mute: "M4 9v6h4l5 4V5L8 9H4zM17 9l5 6M22 9l-5 6",
  fit: "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7",
  camera: "M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM12 10a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z",
  home: "M3 11l9-7 9 7M5 10v10h5v-6h4v6h5V10",
  edit: "M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4zM13.5 6.5l4 4",
  share: "M18 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM6 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM8.6 13.5l6.8 4M15.4 6.5l-6.8 4",
  download: "M12 3v12M7 10l5 5 5-5M4 21h16",
  close: "M6 6l12 12M18 6 6 18",
  chevronDown: "M6 9l6 6 6-6",
  chevronRight: "M9 6l6 6-6 6",
  back: "M19 12H5M11 5l-7 7 7 7",
  grip: "M5 9h14M5 15h14",
  up: "M12 19V5M5 12l7-7 7 7",
  down: "M12 5v14M19 12l-7 7-7-7",
  swap: "M7 4v16M3 16l4 4 4-4M17 20V4M21 8l-4-4-4 4",
  motorway: "M4 21 8 3M20 21 16 3M12 5v3M12 11v3M12 17v3M3 7h18",
  road: "M6 21 10 3M18 21 14 3M12 6v2M12 11v2M12 16v2",
  curvy: "M5 21c0-6 4-7 7-9s5-4 5-9M9 21c0-4 3-5 5-7",
  twisty: "M3 17c2-4 4-4 5 0s3 4 5 0 3-4 5 0 2 2 3 0M3 11c2-4 4-4 5 0s3 4 5 0 3-4 5 0 2 2 3 0",
  mountain: "M2 20 9 7l4 7 3-4 6 10H2zM9 7l2 4",
  navigate: "M12 2 20 21l-8-4-8 4 8-19z",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
  distance: "M3 12h14M13 8l4 4-4 4M21 5v14",
  bends: "M4 20c0-5 3-6 6-8s4-4 4-8M14 4h4M20 20h-6c0-3 2-5 4-6",
  star: "M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9L12 3z",
  check: "M5 12l5 5 9-10",
  stop: "M6 6h12v12H6z",
} as const;

export type IconName = keyof typeof PATHS;

interface Props {
  name: IconName;
  size?: number;
  /** Filled shapes (play, stop, navigate) look better solid. */
  filled?: boolean;
  className?: string;
}

export default function Icon({ name, size = 20, filled, className }: Props) {
  return (
    <svg
      className={`icon${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={filled ? 1.5 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
