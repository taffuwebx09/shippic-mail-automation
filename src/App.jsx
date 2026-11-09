import { useEffect, useRef, useState } from "react";
import { Search, Package, ShieldCheck, ImagePlus, X, CheckCircle2, Puzzle, ExternalLink, Sparkles } from "lucide-react";
import "./lookup.css";

const CHAT_URL = "https://chat.google.com/app/chat/AAAA88R6rOc";

export default function App() {
  const [waybill, setWaybill] = useState("");
  const [image, setImage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [notice, setNotice] = useState({ kind: "info", text: "Enter a waybill number. Install the companion extension to search your private Google Chat group." });
  const fileRef = useRef(null);

  useEffect(() => {
    const onMessage = (event) => {
      if (event.source !== window || event.origin !== window.location.origin || event.data?.source !== "shippic-extension") return;
      const d = event.data;
      if (d.type === "EXTENSION_READY") setConnected(true);
      if (d.type === "SEARCH_STARTED") { setBusy(true); setNotice({ kind: "info", text: "Searching SHIP PIC3 for the exact waybill…" }); }
      if (d.type === "SEARCH_RESULT") {
        setBusy(false);
        if (d.imageDataUrl) { setImage({ url: d.imageDataUrl, waybill: d.waybill || waybill }); setNotice({ kind: "success", text: "Matching shipment photo received from Google Chat." }); }
        else setNotice({ kind: "error", text: d.message || "No image was found for this waybill." });
      }
      if (d.type === "SEARCH_ERROR") { setBusy(false); setNotice({ kind: "error", text: d.message || "Extension error. Check that it is enabled." }); }
    };
    window.addEventListener("message", onMessage);
    window.postMessage({ source: "shippic-web", type: "PING_EXTENSION" }, window.location.origin);
    return () => window.removeEventListener("message", onMessage);
  }, [waybill]);

  const searchShipment = () => {
    const number = waybill.trim().replace(/^'+/, "");
    if (!/^\d{8,25}$/.test(number)) { setNotice({ kind: "error", text: "Enter a valid waybill number (8–25 digits)." }); return; }
    setWaybill(number); setImage(null); setBusy(true);
    window.postMessage({ source: "shippic-web", type: "SEARCH_WAYBILL", waybill: number }, window.location.origin);
    setNotice({ kind: "info", text: "Sending waybill to the ShipPic extension…" });
  };

  const manualImage = (file) => {
    if (!file?.type?.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => { setImage({ url: reader.result, waybill }); setNotice({ kind: "success", text: "Image added manually." }); };
    reader.readAsDataURL(file);
  };
  const onPaste = (e) => {
    const item = Array.from(e.clipboardData?.items || []).find((x) => x.type.startsWith("image/"));
    if (!item) return;
    e.preventDefault(); manualImage(item.getAsFile());
  };

  return <div className="app-shell lookup-app" onPaste={onPaste}>
    <header className="topbar">
      <a className="brand" href="/"><span className="brand-mark"><Package size={20}/></span><span className="brand-copy"><b>ShipPic</b><small>MAIL AUTOMATION</small></span></a>
      <div className="topbar-meta"><span className="secure"><ShieldCheck size={15}/> Private browser workflow</span><span className={`extension-pill ${connected ? "ready" : ""}`}><i/>{connected ? "EXTENSION CONNECTED" : "EXTENSION NEEDED"}</span></div>
    </header>
    <main>
      <section className="hero"><div className="eyebrow"><i/> SHIPMENT EVIDENCE WORKSPACE</div><h1>Find the photo.<br/><span>Build the email.</span></h1><p>Enter a waybill to search your SHIP PIC3 Google Chat group and bring its shipment image here.</p></section>
      <section className="workspace">
        <div className="section-heading"><div><div className="step-label">STEP 01 · SHIPMENT SEARCH</div><h2>Find shipment image</h2></div><span className="draft-pill"><i/> GOOGLE CHAT</span></div>
        <label className="waybill-label" htmlFor="waybill">WAYBILL NUMBER <span>Searches SHIP PIC3</span></label>
        <div className="lookup-search-row"><div className="lookup-input-wrap"><Search size={17}/><input id="waybill" value={waybill} onChange={e=>setWaybill(e.target.value)} onKeyDown={e=>e.key==="Enter"&&!busy&&searchShipment()} placeholder="e.g. 1490842594719645"/></div><button className="lookup-primary" disabled={busy} onClick={searchShipment}>{busy?"Searching…":<><Search size={16}/> Search shipment</>}</button></div>
        <div className="lookup-group"><span className="lookup-chat-mark">S</span><div><b>SHIP PIC3</b><small>Google Chat group · Exact waybill search</small></div><a href={CHAT_URL} target="_blank" rel="noreferrer">Open group <ExternalLink size={13}/></a></div>
        <div className="capture-card">
          {image ? <div className="preview-wrap"><div className="preview-toolbar"><div className="preview-file"><span className="file-icon"><ImagePlus size={16}/></span><div><b>Shipment image found</b><small>Waybill {image.waybill || waybill}</small></div></div><button className="icon-button" onClick={()=>setImage(null)} aria-label="Remove image"><X size={17}/></button></div><div className="image-stage"><img src={image.url} alt={`Shipment evidence for ${image.waybill || waybill}`}/></div><div className="preview-footer"><span><CheckCircle2 size={16}/> Image ready for email</span><button className="text-button danger" onClick={()=>setImage(null)}>Remove image</button></div></div>
          : <div className="empty-state"><div className="upload-icon"><ImagePlus size={25}/></div><h3>Your shipment image will appear here</h3><p>Enter a waybill above and press <b>Search shipment</b>.<br/>The extension looks for the matching waybill and its photo.</p><div className="or-divider"><span/> OR <span/></div><button className="secondary-button" onClick={()=>fileRef.current?.click()}><ImagePlus size={16}/> Upload / paste manually</button><input ref={fileRef} type="file" accept="image/*" hidden onChange={e=>manualImage(e.target.files?.[0])}/><small className="drop-hint">Manual image preview as fallback</small></div>}
        </div>
        <div className={`notice ${notice.kind}`} role="status"><Sparkles size={17}/><span>{notice.text}</span></div>
        {!connected&&<div className="lookup-extension-note"><Puzzle size={19}/><div><b>Chrome Extension required</b><p>The website cannot access a private Chat group by itself. Install the companion extension and reload this page.</p><a href="https://github.com/taffuwebx09/shippic-mail-automation/tree/main/extension" target="_blank" rel="noreferrer">Extension source in GitHub <ExternalLink size={13}/></a></div></div>}
        <div className="next-step"><div className="next-icon"><Package size={18}/></div><div><b>Next: email builder</b><p>FYI body, shipment details, photo, and signature will be added after lookup is verified.</p></div><span className="locked-tag">NEXT</span></div>
      </section>
    </main>
    <footer><span>ShipPic Mail Automation</span><span>Search → Match → Image</span></footer>
  </div>;
}