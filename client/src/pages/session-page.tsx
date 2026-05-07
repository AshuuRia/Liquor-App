import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { DecodeHintType } from "@zxing/library";
import { scanImageData, setModuleArgs } from "@undecaf/zbar-wasm";
// @ts-ignore
import zbarWasmUrl from "@undecaf/zbar-wasm/dist/zbar.wasm?url";
import {
  Camera, CameraOff, Search, X, Trash2, Download, FileText,
  Package, AlertTriangle, RotateCcw, ChevronDown, ChevronUp, Edit3, Check
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import type { LiquorRecord } from "@shared/schema";

setModuleArgs({ locateFile: () => zbarWasmUrl });

const hasBarcodeDetector = typeof window !== "undefined" && "BarcodeDetector" in window;
const CONFIRM_FRAMES = 3;
const SCAN_COOLDOWN_MS = 1500;

function playBeep(success: boolean) {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    if (success) {
      osc.frequency.setValueAtTime(1046, ctx.currentTime);
      gain.gain.setValueAtTime(0.4, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.18);
      osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.18);
    } else {
      osc.frequency.setValueAtTime(400, ctx.currentTime);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.25);
      osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.25);
    }
  } catch { /* not critical */ }
}

function vibrate(p: number | number[]) { try { navigator.vibrate?.(p); } catch { /* ignore */ } }

function normalizeBarcode(raw: string) {
  if (/^\d+$/.test(raw)) {
    if (raw.length === 14 && raw.startsWith("00")) return raw.slice(2);
    if (raw.length === 13 && raw.startsWith("0"))  return raw.slice(1);
  }
  return raw;
}

function fmt(price: number | string | null | undefined) {
  if (price == null) return "—";
  const n = typeof price === "number" ? price : parseFloat(price as string);
  return isNaN(n) ? "—" : `$${n.toFixed(2)}`;
}

interface ScannedItem {
  id: string; sessionId: string; scannedBarcode: string; scannedAt: string; quantity: number;
  product?: {
    liquorCode: string; brandName: string; adaNumber: string; adaName: string; vendorName: string;
    proof: string; bottleSize: string; packSize: string; onPremisePrice: number|string;
    offPremisePrice: number|string; shelfPrice: number|string; upcCode1: string; upcCode2: string; effectiveDate: string;
  } | null;
}

// ── Disambiguation sheet ──────────────────────────────────────────────────────
function PickerSheet({ choices, barcode, onPick, onClose }: {
  choices: LiquorRecord[]; barcode: string; onPick: (r: LiquorRecord) => void; onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/50" onClick={onClose}>
      <div className="w-full bg-white dark:bg-zinc-900 rounded-t-2xl shadow-2xl max-h-[75vh] overflow-y-auto"
           onClick={e => e.stopPropagation()}
           style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 4rem)" }}>
        <div className="flex justify-center pt-3 pb-1"><div className="w-10 h-1 rounded-full bg-zinc-300 dark:bg-zinc-600" /></div>
        <div className="px-5 pb-4">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            <div>
              <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Multiple products found</h3>
              <p className="text-xs text-zinc-500">Tap the bottle you're scanning</p>
            </div>
          </div>
          <div className="space-y-2">
            {choices.map(r => (
              <button key={r.id} onClick={() => onPick(r)}
                className="w-full text-left px-4 py-3 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 active:bg-zinc-50">
                <div className="font-semibold text-sm text-zinc-900 dark:text-zinc-100">{r.brandName}</div>
                <div className="flex items-center gap-3 mt-0.5 text-xs text-zinc-500">
                  <span>{r.bottleSize}</span>
                  {r.proof && <span>{r.proof}°</span>}
                  <span className="ml-auto font-bold text-zinc-800 dark:text-zinc-200">{fmt(r.shelfPrice)}</span>
                </div>
                <div className="text-xs text-zinc-400 mt-0.5">Code: {r.liquorCode} · {r.vendorName}</div>
              </button>
            ))}
          </div>
          <Button variant="outline" className="w-full mt-3" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}

// ── Scanner camera view ───────────────────────────────────────────────────────
function ScannerView({ onScan, onClose }: { onScan: (code: string) => void; onClose: () => void }) {
  const videoRef   = useRef<HTMLVideoElement>(null);
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const streamRef  = useRef<MediaStream | null>(null);
  const animRef    = useRef<number>(0);
  const zxingRef   = useRef<BrowserMultiFormatReader>();
  const candidateRef  = useRef(""); const countRef = useRef(0);
  const cooldownRef   = useRef(0);
  const lastCodeRef   = useRef(""); const lastTimeRef = useRef(0);
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState("");
  const [manualInput, setManualInput] = useState("");
  const [mode, setMode] = useState<"camera"|"manual">("camera");

  const confirmCode = useCallback((code: string) => {
    if (Date.now() < cooldownRef.current) return false;
    if (code === candidateRef.current) countRef.current += 1;
    else { candidateRef.current = code; countRef.current = 1; }
    return countRef.current >= CONFIRM_FRAMES;
  }, []);

  const emitScan = useCallback((code: string) => {
    const now = Date.now();
    if (code === lastCodeRef.current && now - lastTimeRef.current < 2000) return;
    lastCodeRef.current = code; lastTimeRef.current = now;
    cooldownRef.current = now + SCAN_COOLDOWN_MS;
    candidateRef.current = ""; countRef.current = 0;
    onScan(code);
  }, [onScan]);

  const startNative = useCallback(async () => {
    let det: any;
    try { det = new (window as any).BarcodeDetector({ formats: ["ean_13","ean_8","upc_a","upc_e","code_128","code_39"] }); }
    catch { det = new (window as any).BarcodeDetector(); }
    const scan = async () => {
      const v = videoRef.current;
      if (v && v.readyState >= 2) {
        try { const r = await det.detect(v); if (r.length > 0) { if (confirmCode(r[0].rawValue)) emitScan(r[0].rawValue); } else { candidateRef.current = ""; countRef.current = 0; } } catch {}
      }
      animRef.current = requestAnimationFrame(scan);
    };
    animRef.current = requestAnimationFrame(scan);
  }, [confirmCode, emitScan]);

  const startZbar = useCallback(async () => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const scan = async () => {
      const v = videoRef.current;
      if (v && v.readyState >= 2 && v.videoWidth) {
        if (canvas.width !== v.videoWidth) { canvas.width = v.videoWidth; canvas.height = v.videoHeight; }
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        try { const r = await scanImageData(ctx.getImageData(0, 0, canvas.width, canvas.height)); if (r.length > 0) { if (confirmCode(r[0].decode())) emitScan(r[0].decode()); } else { candidateRef.current = ""; countRef.current = 0; } } catch {}
      }
      animRef.current = requestAnimationFrame(scan);
    };
    animRef.current = requestAnimationFrame(scan);
  }, [confirmCode, emitScan]);

  const startZxing = useCallback(async () => {
    const hints = new Map(); hints.set(DecodeHintType.TRY_HARDER, true);
    zxingRef.current = new BrowserMultiFormatReader(hints);
    await zxingRef.current.decodeFromVideoDevice(undefined, videoRef.current!, (result) => {
      if (result) { const c = result.getText(); if (confirmCode(c)) emitScan(c); else { candidateRef.current = ""; countRef.current = 0; } }
    });
  }, [confirmCode, emitScan]);

  const start = useCallback(async () => {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } } });
      streamRef.current = stream; videoRef.current!.srcObject = stream;
      await videoRef.current!.play(); setIsScanning(true);
      if (hasBarcodeDetector) await startNative();
      else { try { await startZbar(); } catch { await startZxing(); } }
    } catch (e) { setError(e instanceof Error ? e.message : "Camera failed"); }
  }, [startNative, startZbar, startZxing]);

  const stop = useCallback(() => {
    cancelAnimationFrame(animRef.current); zxingRef.current?.stopContinuousDecode?.();
    streamRef.current?.getTracks().forEach(t => t.stop()); streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null; setIsScanning(false);
  }, []);

  useEffect(() => { if (mode === "camera") start(); else stop(); return stop; }, [mode]);

  return (
    <div className="flex flex-col h-full">
      {/* Mode toggle */}
      <div className="flex bg-zinc-100 dark:bg-zinc-800 rounded-xl p-1 mx-4 mb-3">
        {(["camera","manual"] as const).map(m => (
          <button key={m} onClick={() => setMode(m)}
            className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors capitalize
              ${mode === m ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-sm" : "text-zinc-500"}`}>
            {m === "camera" ? "Camera" : "Manual Input"}
          </button>
        ))}
      </div>

      {mode === "camera" && (
        <div className="relative flex-1 mx-4 rounded-2xl overflow-hidden bg-black">
          <video ref={videoRef} className="w-full h-full object-cover" style={{ display: isScanning ? "block" : "none" }} muted playsInline data-testid="video-session-scanner" />
          <canvas ref={canvasRef} className="hidden" />
          {!isScanning && !error && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center"><Camera className="h-10 w-10 text-zinc-600 mx-auto mb-2" /><p className="text-zinc-400 text-sm">Starting camera…</p></div>
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center px-6">
              <div className="text-center"><p className="text-white font-medium mb-2">Camera error</p><p className="text-zinc-400 text-sm mb-3">{error}</p><Button size="sm" onClick={start}>Retry</Button></div>
            </div>
          )}
          {isScanning && (
            <>
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="relative w-56 h-36">
                  {[["top-0 left-0 border-t-4 border-l-4 rounded-tl-lg"],["top-0 right-0 border-t-4 border-r-4 rounded-tr-lg"],
                    ["bottom-0 left-0 border-b-4 border-l-4 rounded-bl-lg"],["bottom-0 right-0 border-b-4 border-r-4 rounded-br-lg"]]
                    .map(([c], i) => <div key={i} className={`absolute w-7 h-7 border-white ${c}`} />)}
                </div>
              </div>
              <button onClick={() => { stop(); setTimeout(start, 150); }}
                className="absolute top-3 right-3 w-8 h-8 rounded-full bg-black/50 flex items-center justify-center">
                <RotateCcw className="h-4 w-4 text-white" />
              </button>
            </>
          )}
        </div>
      )}

      {mode === "manual" && (
        <div className="mx-4 flex gap-2">
          <Input autoFocus value={manualInput} onChange={e => setManualInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && manualInput.trim()) { emitScan(manualInput.trim()); setManualInput(""); } }}
            placeholder="Type barcode or code, press Enter…"
            className="flex-1" data-testid="input-session-barcode" />
          <Button onClick={() => { if (manualInput.trim()) { emitScan(manualInput.trim()); setManualInput(""); } }} disabled={!manualInput.trim()}>
            Add
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Scanned item card ─────────────────────────────────────────────────────────
function ItemCard({ item, sessionId, onDelete, onPriceUpdate }: {
  item: ScannedItem; sessionId: string; onDelete: () => void; onPriceUpdate: (newPrice: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [priceVal, setPriceVal] = useState("");
  const { toast } = useToast();

  const savePrice = async () => {
    const n = parseFloat(priceVal);
    if (isNaN(n) || n < 0) return;
    try {
      const r = await fetch("/api/update-item-price", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, itemId: item.id, newPrice: n }),
      });
      if (r.ok) { onPriceUpdate(n); setEditing(false); toast({ title: "Price updated", description: fmt(n) }); }
    } catch { toast({ variant: "destructive", title: "Failed to update price" }); }
  };

  const p = item.product;
  if (!p) return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl px-4 py-3 flex items-center justify-between shadow-sm">
      <div>
        <div className="text-sm font-medium text-zinc-500">Unknown barcode</div>
        <div className="text-xs text-zinc-400">{item.scannedBarcode}</div>
      </div>
      <button onClick={onDelete} className="p-1.5 rounded-lg text-red-400 active:bg-red-50"><Trash2 className="h-4 w-4" /></button>
    </div>
  );

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl px-4 py-3 shadow-sm" data-testid={`session-item-${item.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm text-zinc-900 dark:text-zinc-100 leading-tight">{p.brandName}</div>
          <div className="text-xs text-zinc-500 mt-0.5">{p.bottleSize} · {p.liquorCode}</div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {editing ? (
            <>
              <Input value={priceVal} onChange={e => setPriceVal(e.target.value)} onKeyDown={e => e.key === "Enter" && savePrice()}
                className="w-20 h-7 text-sm" autoFocus />
              <button onClick={savePrice} className="p-1 text-green-500"><Check className="h-4 w-4" /></button>
              <button onClick={() => setEditing(false)} className="p-1 text-zinc-400"><X className="h-4 w-4" /></button>
            </>
          ) : (
            <>
              <span className="text-sm font-bold text-blue-600 dark:text-blue-400">{fmt(p.shelfPrice)}</span>
              <button onClick={() => { setEditing(true); setPriceVal(String(p.shelfPrice)); }} className="p-1 text-zinc-400"><Edit3 className="h-3.5 w-3.5" /></button>
            </>
          )}
          <button onClick={onDelete} className="p-1.5 rounded-lg text-red-400 active:bg-red-50"><Trash2 className="h-4 w-4" /></button>
        </div>
      </div>
      <div className="flex gap-3 mt-1.5 text-xs text-zinc-400">
        <span>ADA: {p.adaNumber}</span>
        {p.proof && <span>{p.proof}°</span>}
        <span>{p.vendorName}</span>
      </div>
    </div>
  );
}

export default function SessionPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [items, setItems]         = useState<ScannedItem[]>([]);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [pickerOpen, setPickerOpen]   = useState(false);
  const [pickerChoices, setPickerChoices] = useState<LiquorRecord[]>([]);
  const [pickerBarcode, setPickerBarcode] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<LiquorRecord[]>([]);
  const [showSearch, setShowSearch]   = useState(false);
  const [loading, setLoading] = useState(false);
  const searchDebounce = useRef<ReturnType<typeof setTimeout>>();

  const { data: activeData } = useQuery({ queryKey: ["/api/sessions/active"] });
  const activeSession = (activeData as any)?.session;

  useEffect(() => {
    if (activeSession) { setSessionId(activeSession.id); }
    else { createSession(); }
  }, [activeSession]);

  useEffect(() => { if (sessionId) fetchItems(); }, [sessionId]);

  const createSession = async () => {
    try {
      const r = await fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `Session ${new Date().toLocaleDateString()}` }) });
      const d = await r.json();
      if (d.success) { setSessionId(d.session.id); qc.invalidateQueries({ queryKey: ["/api/sessions"] }); }
    } catch { /* ignore */ }
  };

  const fetchItems = async () => {
    if (!sessionId) return;
    setLoading(true);
    try { const r = await fetch(`/api/scanned-items/${sessionId}`); const d = await r.json(); setItems(d.items || []); }
    catch { /* ignore */ } finally { setLoading(false); }
  };

  const handleScan = async (raw: string) => {
    const barcode = normalizeBarcode(raw);
    setScannerOpen(false);
    try {
      const r = await fetch("/api/scan-barcode", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ barcode, sessionId }) });
      const d = await r.json();
      if (d.success && d.requiresSelection) {
        vibrate([60, 30, 60]); playBeep(true);
        setPickerBarcode(barcode); setPickerChoices(d.matchedProducts); setPickerOpen(true);
      } else if (d.success && d.matchedProduct) {
        vibrate(80); playBeep(true);
        toast({ title: d.matchedProduct.brandName, description: `${d.matchedProduct.bottleSize} · ${fmt(d.matchedProduct.shelfPrice)}` });
        fetchItems();
      } else {
        vibrate([60,40,60,40,60]); playBeep(false);
        toast({ variant: "destructive", title: "Not found", description: `No match for ${barcode}` });
      }
    } catch { toast({ variant: "destructive", title: "Scan error" }); }
  };

  const addItem = async (rec: LiquorRecord, barcode: string) => {
    try {
      const r = await fetch("/api/add-item", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ liquorRecordId: rec.id, sessionId, scannedBarcode: barcode }) });
      const d = await r.json();
      if (d.success) { toast({ title: rec.brandName, description: fmt(rec.shelfPrice) }); fetchItems(); }
    } catch { /* ignore */ }
  };

  const deleteItem = async (itemId: string) => {
    try {
      await fetch(`/api/scanned-items/${sessionId}/${itemId}`, { method: "DELETE" });
      setItems(p => p.filter(i => i.id !== itemId));
    } catch { /* ignore */ }
  };

  const clearAll = async () => {
    if (!window.confirm("Clear all scanned items?")) return;
    await fetch(`/api/scanned-items/${sessionId}`, { method: "DELETE" });
    setItems([]);
    toast({ title: "Cleared" });
  };

  const exportPTouch = () => {
    if (!items.length) return;
    const withProducts = items.filter(i => i.product);
    const headers = ["Upc","Department","qty","cents","incltaxes","inclfees","Name","Price","size","ebt","byweight","Fee Multiplier","cost_qty","cost_cents","variable_price","addstock","setstock","pack_name","pack_qty","pack_upc","unit_upc","unit_count","is_oneclick","oc_color","oc_border_color","oc_text_color","oc_fixedpos","oc_page","oc_key","oc_relpos"];
    const rows = withProducts.map(item => {
      const price = typeof item.product!.shelfPrice === "number" ? item.product!.shelfPrice : parseFloat(item.product!.shelfPrice as string);
      const name  = `${item.product!.brandName} ${item.product!.bottleSize.replace(/\s+/g,"")}`;
      return [`"${item.scannedBarcode}"`, "Liquor", "1", Math.round(price*100), "n", "n", `"${name}"`, `$${price.toFixed(2)}`, `"${item.product!.liquorCode.replace(/^0+/,"") || "0"}"`, "", "n", "1", "1", "0", "n", "", `"=""0"""`, "", "", "", "", "", "n", "", "", "", "", "", "", ""].join(",");
    });
    const csv = [headers.join(","), ...rows].join("\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `ptouch_${new Date().toISOString().split("T")[0]}.csv`; a.click();
    toast({ title: "P-touch CSV exported", description: `${withProducts.length} items` });
  };

  // Search for manual add
  useEffect(() => {
    if (!showSearch || searchQuery.length < 2) { setSearchResults([]); return; }
    clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(async () => {
      const r = await fetch(`/api/search-liquor?query=${encodeURIComponent(searchQuery)}`);
      const d = await r.json(); setSearchResults(d.results || []);
    }, 280);
  }, [searchQuery, showSearch]);

  return (
    <div className="flex flex-col bg-zinc-50 dark:bg-zinc-950"
         style={{ height: "calc(100vh - 4rem)", paddingTop: "env(safe-area-inset-top)" }}>

      {/* Header */}
      <div className="bg-white dark:bg-zinc-900 px-4 pt-4 pb-3 shadow-sm flex-shrink-0">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">Session</h1>
            <p className="text-xs text-zinc-500">{items.length} item{items.length !== 1 ? "s" : ""} scanned</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setShowSearch(v => !v)}
              className={`w-9 h-9 rounded-full flex items-center justify-center ${showSearch ? "bg-blue-100 dark:bg-blue-900/40" : "bg-zinc-100 dark:bg-zinc-800"}`}
              data-testid="button-session-search">
              <Search className={`h-4 w-4 ${showSearch ? "text-blue-600" : "text-zinc-500"}`} />
            </button>
            {items.length > 0 && (
              <button onClick={exportPTouch}
                className="w-9 h-9 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center"
                data-testid="button-export-ptouch">
                <Download className="h-4 w-4 text-zinc-500" />
              </button>
            )}
          </div>
        </div>

        {/* Search bar */}
        {showSearch && (
          <div className="mb-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
              <Input autoFocus value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search to add by name, UPC, code…"
                className="pl-9 pr-9 h-10 rounded-xl bg-zinc-100 dark:bg-zinc-800 border-0"
                data-testid="input-session-search" />
              {searchQuery && <button onClick={() => { setSearchQuery(""); setSearchResults([]); }} className="absolute right-3 top-1/2 -translate-y-1/2"><X className="h-4 w-4 text-zinc-400" /></button>}
            </div>
            {searchResults.length > 0 && (
              <div className="mt-1.5 bg-white dark:bg-zinc-900 rounded-xl shadow-lg border border-zinc-100 dark:border-zinc-800 max-h-52 overflow-y-auto">
                {searchResults.map((r, i) => (
                  <button key={r.id} onClick={() => { addItem(r, r.upcCode1 || "manual"); setShowSearch(false); setSearchQuery(""); setSearchResults([]); }}
                    className="w-full text-left px-4 py-3 border-b border-zinc-50 dark:border-zinc-800 last:border-b-0 active:bg-zinc-50"
                    data-testid={`session-search-result-${i}`}>
                    <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{r.brandName}</div>
                    <div className="text-xs text-zinc-500">{r.bottleSize} · {r.liquorCode} · {fmt(r.shelfPrice)}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Scanner toggle */}
        <button
          onClick={() => setScannerOpen(v => !v)}
          data-testid="button-toggle-scanner"
          className={`w-full py-3 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-colors
            ${scannerOpen ? "bg-red-500 text-white" : "bg-blue-600 text-white"}`}>
          {scannerOpen ? <><CameraOff className="h-4 w-4" />Close Scanner</> : <><Camera className="h-4 w-4" />Start Scanner</>}
        </button>
      </div>

      {/* Scanner */}
      {scannerOpen && (
        <div className="bg-white dark:bg-zinc-900 py-4 border-b border-zinc-200 dark:border-zinc-800 flex-shrink-0">
          <ScannerView onScan={handleScan} onClose={() => setScannerOpen(false)} />
        </div>
      )}

      {/* Items list */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {loading && (
          <div className="flex justify-center py-8">
            <div className="h-6 w-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {!loading && items.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16">
            <Package className="h-12 w-12 text-zinc-300 dark:text-zinc-700 mb-3" />
            <p className="text-zinc-500 font-medium">No items scanned yet</p>
            <p className="text-zinc-400 text-sm mt-1">Tap "Start Scanner" or search to add items</p>
          </div>
        )}

        {items.map(item => (
          <ItemCard key={item.id} item={item} sessionId={sessionId!}
            onDelete={() => deleteItem(item.id)}
            onPriceUpdate={n => setItems(p => p.map(i => i.id === item.id && i.product ? { ...i, product: { ...i.product!, shelfPrice: n } } : i))} />
        ))}

        {items.length > 0 && (
          <button onClick={clearAll}
            className="w-full py-3 rounded-xl border border-red-200 dark:border-red-900 text-red-500 text-sm font-medium flex items-center justify-center gap-2 mt-2">
            <Trash2 className="h-4 w-4" /> Clear All Items
          </button>
        )}
      </div>

      {/* Picker sheet */}
      {pickerOpen && (
        <PickerSheet choices={pickerChoices} barcode={pickerBarcode}
          onPick={rec => { addItem(rec, pickerBarcode); setPickerOpen(false); }}
          onClose={() => setPickerOpen(false)} />
      )}
    </div>
  );
}
