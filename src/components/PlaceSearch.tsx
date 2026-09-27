import { useEffect, useRef, useState } from "react";
import { autocomplete, placeLocation, type Suggestion } from "../lib/places";
import type { LatLng } from "../lib/geo";

interface Props {
  apiKey: string;
  near?: LatLng;
  placeholder: string;
  onPick: (name: string, position: LatLng) => void;
}

export default function PlaceSearch({ apiKey, near, placeholder, onPick }: Props) {
  const [text, setText] = useState("");
  const [items, setItems] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(0);
  const [error, setError] = useState("");
  const nearRef = useRef(near);
  nearRef.current = near;

  useEffect(() => {
    if (text.trim().length < 3) {
      setItems([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      autocomplete(apiKey, text, nearRef.current, ctrl.signal)
        .then((s) => {
          setItems(s);
          setActive(0);
          setError("");
        })
        .catch((e: Error) => e.name !== "AbortError" && setError(e.message));
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [text, apiKey]);

  async function pick(s: Suggestion) {
    setItems([]);
    setText("");
    try {
      const place = await placeLocation(apiKey, s.placeId);
      onPick(s.main || place.name, place.position);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="search">
      <input
        type="search"
        value={text}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, items.length - 1));
          else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
          else if (e.key === "Enter" && items[active]) pick(items[active]);
          else if (e.key === "Escape") setItems([]);
          else return;
          e.preventDefault();
        }}
      />
      {items.length > 0 && (
        <ul className="suggestions" role="listbox">
          {items.map((s, i) => (
            <li
              key={s.placeId}
              role="option"
              aria-selected={i === active}
              className={i === active ? "active" : ""}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
            >
              <strong>{s.main}</strong>
              <span>{s.secondary}</span>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}
