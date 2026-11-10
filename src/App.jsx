import { useEffect, useRef, useState } from "react";
import { Search, Package, ShieldCheck, X, CheckCircle2, Puzzle, ExternalLink, Sparkles } from "lucide-react";
import "./lookup.css";

const CHAT_URL = "https://chat.google.com/app/chat/AAAA88R6rOc";

export default function App() {
  const [waybill, setWaybill] = useState("");
  const [image, setImage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [extensionVersion, setExtensionVersion] = useState("");
  const [notice, setNotice] = useState({ kind: "info", text: "Enter a waybill number. Install the companion extension to search your private Google Chat group." });
  const inputRef = useRef(null);
  const searchTimeoutRef = useRef(null);

  useEffect(() => {
    const onMessage = (event) => {
      if (event.source !== window || event.origin !== window.location.origin || event.data?.source !== "shippic-extension") return;
      const d = event.data;
      if (d.type === "EXTENSION_READY") {
        setConnected(true);
        setExtensionVersion(d.extensionVersion || "unknown");
      }
      if (d.type === "SEARCH_STARTED") {
        setBusy(true);
        setNotice({ kind: "info", text: "Searching SHIP PIC3 in the background…" });
      }
      if (d.type === "SEARCH_RESULT") {
        clearTimeout(searchTimeoutRef.current);
        setBusy(false);
        if (d.imageDataUrl) {
          setImage({ url: d.imageDataUrl, waybill: d.waybill || waybill });
          const seconds = Number.isFinite(d.durationMs) ? (d.durationMs / 1000).toFixed(1) : null;
          setNotice({ kind: "success", text: seconds ? `Shipment photo received in ${seconds}s.` : "Shipment photo received and displayed here." });
        } else {
          setNotice({ kind: "error", text: d.message || "No shipment photo was found." });
        }
      }
      if (d.type === "SEARCH_ERROR") {
        clearTimeout(searchTimeoutRef.current);
        setBusy(false);
        setNotice({ kind: "error", text: d.message || "Background lookup failed. Check the extension and Google Chat sign-in." });
      }
    };
    window.addEventListener("message", onMessage);
    window.postMessage({ source: "shippic-web", type: "PING_EXTENSION" }, window.location.origin);
    return () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(searchTimeoutRef.current);
    };
  }, []);

  const searchShipment = () => {
    const number = waybill.trim().replace(/^'+/, "");
    if (!/^\d{8,25}$/.test(number)) {
      setNotice({ kind: "error", text: "Enter a valid waybill number (8–25 digits)." });
      return;
    }
    setWaybill(number);
    setImage(null);
    setBusy(true);
    setNotice({ kind: "info", text: "Starting background lookup in SHIP PIC3…" });
    clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      setBusy(false);
      setNotice({ kind: "error", text: "Search timed out after 90 seconds. Reload this page and the extension, then try again. If it repeats, check the extension service worker console." });
    }, 90000);
    window.postMessage({ source: "shippic-web", type: "SEARCH_WAYBILL", waybill: number }, window.location.origin);
  };

  return <div className="app-shell lookup-app">
    <header className="topbar">
      <a className="brand" href="/"><span className="brand-mark"><Package size={20}/></span><span className="brand-copy"><b>ShipPic</b><small>MAIL AUTOMATION</small></span></a>
      <div className="topbar-meta"><span className="secure"><ShieldCheck size={15}/> Private browser workflow</span><span className={`extension-pill ${connected ? "ready" : ""}`}><i/>{connected ? `EXTENSION CONNECTED · v${extensionVersion}` : "EXTENSION NEEDED"}</span></div>
    </header>
    <main>
      <section className="hero"><div className="eyebrow"><i/> SHIPMENT EVIDENCE WORKSPACE</div><h1>Find the photo.<br/><span>Build the email.</span></h1><p>Enter a waybill and ShipPic will search SHIP PIC3 in the background, then bring the matching shipment photo here.</p></section>
      <section className="workspace">
        <div className="section-heading"><div><div className="step-label">STEP 01 · SHIPMENT SEARCH</div><h2>Find shipment image</h2></div><span className="draft-pill"><i/> BACKGROUND CHAT LOOKUP</span></div>
        <label className="waybill-label" htmlFor="waybill">WAYBILL NUMBER <span>Searches SHIP PIC3 automatically</span></label>
        <div className="lookup-search-row"><div className="lookup-input-wrap"><Search size={17}/><input ref={inputRef} id="waybill" value={waybill} onChange={e=>setWaybill(e.target.value)} onKeyDown={e=>e.key==="Enter"&&!busy&&searchShipment()} placeholder="e.g. 1490842594719645"/></div><button className="lookup-primary" disabled={busy} onClick={searchShipment}>{busy?"Searching…":<><Search size={16}/> Search shipment</>}</button></div>
        <div className="lookup-group"><span className="lookup-chat-mark">S</span><div><b>SHIP PIC3</b><small>Background Google Chat lookup · Exact waybill</small></div><a href={CHAT_URL} target="_blank" rel="noreferrer">Group link <ExternalLink size={13}/></a></div>
        <div className="capture-card">
          {image ? <div className="preview-wrap"><div className="preview-toolbar"><div className="preview-file"><span className="file-icon"><Package size={16}/></span><div><b>Shipment image found</b><small>Waybill {image.waybill || waybill}</small></div></div><button className="icon-button" onClick={()=>setImage(null)} aria-label="Clear image"><X size={17}/></button></div><div className="image-stage"><img src={image.url} alt={`Shipment evidence for ${image.waybill || waybill}`} onError={() => { setImage(null); setNotice({ kind: "error", text: "The matched photo was received but the browser could not render it. Try searching again or inspect the image download response." }); }}/></div><div className="preview-footer"><span><CheckCircle2 size={16}/> Image ready for email</span><button className="text-button danger" onClick={()=>setImage(null)}>Clear image</button></div></div>
          : <div className="empty-state"><div className="upload-icon"><Package size={25}/></div><h3>Your shipment image will appear here</h3><p>Enter a waybill above and press <b>Search shipment</b>.<br/>ShipPic finds the matching photo in Google Chat and displays it here automatically.</p><div className="drop-hint">{busy ? "Looking for the matching shipment photo…" : "No manual upload needed."}</div></div>}
        </div>
        <div className={`notice ${notice.kind}`} role="status"><Sparkles size={17}/><span>{notice.text}</span></div>
        {!connected&&<div className="lookup-extension-note"><Puzzle size={19}/><div><b>Chrome Extension required</b><p>The website needs the companion extension to access your signed-in private Google Chat session. Install it and reload this page.</p><a href="https://github.com/taffuwebx09/shippic-mail-automation/tree/main/extension" target="_blank" rel="noreferrer">Extension source in GitHub <ExternalLink size={13}/></a></div></div>}
        <div className="next-step"><div className="next-icon"><Package size={18}/></div><div><b>Next: email builder</b><p>FYI body, shipment details, photo, and signature will be added after background image lookup is verified.</p></div><span className="locked-tag">NEXT</span></div>
      </section>
    </main>
    <footer><span>ShipPic Mail Automation</span><span>Background Search → Match → Image</span></footer>
  </div>;
}
