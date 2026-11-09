import { useCallback, useEffect, useRef, useState } from "react";
import { ClipboardPaste, ImagePlus, Trash2, X, CheckCircle2, Package, ShieldCheck, Sparkles, ArrowUpRight } from "lucide-react";

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(2) + " MB";
}

export default function App() {
  const [image, setImage] = useState(null);
  const [waybill, setWaybill] = useState("");
  const [notice, setNotice] = useState({ type: "info", text: "Copy a shipment image from Google Chat, then press Ctrl + V here." });
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);
  const imageUrlRef = useRef(null);

  const captureImage = useCallback((file) => {
    if (!file) return;
    if (!file.type?.startsWith("image/")) {
      setNotice({ type: "error", text: "This clipboard item is not an image. Copy the image itself and try again." });
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      setNotice({ type: "error", text: "Image is larger than 12 MB. Please use a smaller image." });
      return;
    }
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    const url = URL.createObjectURL(file);
    imageUrlRef.current = url;
    setImage({ file, url, size: file.size, type: file.type });
    setNotice({ type: "success", text: "Shipment image captured and previewed." });
  }, []);

  const onPaste = useCallback((event) => {
    const items = Array.from(event.clipboardData?.items || []);
    const imageItem = items.find((item) => item.type.startsWith("image/"));
    if (imageItem) {
      event.preventDefault();
      captureImage(imageItem.getAsFile());
    }
  }, [captureImage]);

  useEffect(() => {
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [onPaste]);

  useEffect(() => () => {
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
  }, []);

  const clearImage = () => {
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    imageUrlRef.current = null;
    setImage(null);
    setNotice({ type: "info", text: "Image removed. Copy another shipment image and paste it here." });
  };

  const onDrop = (event) => {
    event.preventDefault();
    setDragging(false);
    const file = Array.from(event.dataTransfer.files || []).find((item) => item.type.startsWith("image/"));
    if (file) captureImage(file);
    else setNotice({ type: "error", text: "Please drop an image file into this area." });
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="ShipPic home">
          <span className="brand-mark"><Package size={20} /></span>
          <span className="brand-copy"><b>ShipPic</b><small>MAIL AUTOMATION</small></span>
        </a>
        <div className="topbar-meta"><span className="secure"><ShieldCheck size={15} /> Browser capture</span><span className="version">MILESTONE 01</span></div>
      </header>

      <main>
        <section className="hero">
          <div className="eyebrow"><i /> SHIPMENT EVIDENCE WORKSPACE</div>
          <h1>One image closer to<br /><span>the right email.</span></h1>
          <p>Bring shipment photos from your Ship Pic Google Chat group into one clean workspace. We’re starting with image paste and preview.</p>
        </section>

        <section className="workspace">
          <div className="section-heading">
            <div><div className="step-label">STEP 01 <span>·</span> IMAGE CAPTURE</div><h2>Shipment evidence</h2></div>
            <span className="draft-pill"><i /> DRAFT WORKSPACE</span>
          </div>

          <label className="waybill-label" htmlFor="waybill">WAYBILL NUMBER <span>Optional for this first step</span></label>
          <input id="waybill" className="waybill-input" value={waybill} onChange={(e) => setWaybill(e.target.value)} placeholder="Paste shipment / waybill number" />

          <div className={`capture-card ${dragging ? "dragging" : ""} ${image ? "has-image" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop} tabIndex={0} aria-label="Image paste and drop area">
            {image ? (
              <div className="preview-wrap">
                <div className="preview-toolbar">
                  <div className="preview-file"><span className="file-icon"><ImagePlus size={16} /></span><div><b>Shipment image captured</b><small>{image.type} · {formatBytes(image.size)}</small></div></div>
                  <button className="icon-button" onClick={clearImage} aria-label="Remove image"><X size={17} /></button>
                </div>
                <div className="image-stage"><img src={image.url} alt="Pasted shipment evidence" /></div>
                <div className="preview-footer"><span><CheckCircle2 size={16} /> Image ready</span><button className="text-button danger" onClick={clearImage}><Trash2 size={15} /> Remove image</button></div>
              </div>
            ) : (
              <div className="empty-state">
                <div className="upload-icon"><ClipboardPaste size={25} /></div>
                <h3>Paste your shipment image</h3>
                <p>In Google Chat, copy the shipment photo. Return here and press <kbd>Ctrl</kbd> + <kbd>V</kbd>.</p>
                <div className="or-divider"><span /> OR <span /></div>
                <button className="secondary-button" onClick={() => inputRef.current?.click()}><ImagePlus size={16} /> Choose image file</button>
                <input ref={inputRef} type="file" accept="image/*" hidden onChange={(e) => captureImage(e.target.files?.[0])} />
                <small className="drop-hint">You can also drag and drop an image here</small>
              </div>
            )}
          </div>

          <div className={`notice ${notice.type}`} role="status">
            {notice.type === "success" ? <CheckCircle2 size={17} /> : notice.type === "error" ? <X size={17} /> : <Sparkles size={17} />}
            <span>{notice.text}</span>
          </div>

          <div className="next-step">
            <div className="next-icon"><Package size={18} /></div>
            <div><b>Next: shipment details + email format</b><p>We’ll add FYI, waybill details, the shipment photo, and your signature after this image capture step is tested.</p></div>
            <span className="locked-tag">COMING NEXT</span>
          </div>
        </section>
      </main>
      <footer><span>ShipPic Mail Automation</span><span>One milestone at a time <ArrowUpRight size={13} /></span></footer>
    </div>
  );
}
