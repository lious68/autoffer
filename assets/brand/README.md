# AutOffer offer icon (current)

Generated and refined with the built-in image_gen tool. Current master: `autoffer-offer-master.png`. The mark is an open envelope holding a checked offer letter, intended to convey receiving an offer. The earlier A monogram remains in `autoffer-master.png` for reference.

Final refinement prompt:

> Finalize this job-offer envelope app icon as an OPAQUE TWO-COLOR IMAGE. Repaint every background pixel with solid cobalt blue #3265E8, including every corner and all the space around the white symbol. Absolutely NO transparent pixels. Preserve the open envelope with letter silhouette in solid pure white. The large checkmark inside the letter MUST be filled solid cobalt blue, very visible. The diagonal envelope fold separations MUST be solid cobalt blue thick strokes. Remove ALL glow, blur, gray, shadow, gradient, transparency, texture, speckling and halos. Clean high contrast flat vector-like design, only white and blue. Centre the symbol on a full square blue background, no frame or rounded tile, no text. Output a normal opaque square image, NOT a transparent cutout.

Design prompt:

> Use case: logo-brand. Redesign this AutOffer browser extension icon so it clearly communicates RECEIVING A JOB OFFER. Keep the cobalt-blue and white visual identity, but replace the abstract A with ONE unified mark: an open envelope holding a job-offer letter, with a confident bold checkmark on the protruding letter. Integrate the envelope's diagonal folds into a subtle upward A-like silhouette if elegant, but prioritise immediate 'offer received / accepted' recognition. Exactly one large centered compact symbol, bold filled white shapes with broad cobalt negative-space cuts, few parts, optically balanced, legible at 16px. Completely flat opaque uniform cobalt blue #3265E8 background edge to edge, white symbol occupying about 70% of the canvas. No text, no letters spelled out, no wordmark, no tiny lines representing document text, no thin outlines, no hands, no briefcase, no stars, no confetti, no medal, no gradients, no shadows, no textures, no 3D. Do not add a separate badge floating outside the icon. Square production icon only; no mockup or presentation sheet.

Exports in `public/icons/` and the embedded data URL in `src/ui/brand.ts` now use this offer-letter version. Resize with `sips -z SIZE SIZE autoffer-offer-master.png --out OUTPUT`; keep the 16/32/48/128 PNG sizes.

---

# Earlier A-monogram concept

Generated with the built-in image_gen tool. `autoffer-master.png` is the final generated raster master. The first draft was discarded because its background contained unwanted texture and alpha artifacts.

Final edit prompt:

> Refine this AutOffer icon for production. Preserve the exact central white A/checkmark monogram geometry. Replace ALL of the background with ONE perfectly uniform solid cobalt blue #3265E8. A completely opaque square tile from edge to edge, NO transparency anywhere, NO rounded outer corners, NO margin, NO shadow, NO highlights, NO gradients, NO grain, NO texture, NO black patches, NO speckles. The white mark is uniform pure white. Precisely two flat colors only except antialiasing edges. Monogram optically centered occupying 66% of the canvas. Clean tiny browser toolbar icon, not a rendered physical object. Single square image only.

Original generation prompt:

> Use case: logo-brand. Create ONE production-ready app icon for AutOffer, a compact browser extension for assessment assistance. A distinctive geometric capital A monogram subtly incorporating a checkmark in its right stroke, strong white silhouette on a solid cobalt-blue (#3265E8) rounded-square tile. Flat, precise, confident, minimal browser-toolbar icon, legible at 16px. No letters other than the abstract A, no wordmark, no text, no border, no gradients, no texture, no shadow, no 3D, no mockup, no decorative sparkles. Square 1024x1024 output. The rounded-square blue tile fills 94% of the image, centered with small genuinely transparent outer margin and transparent outer corners; white A centred optically, broad strokes and generous negative space. Crisp clean vector-like shapes. Output only the finished single icon, not a presentation sheet.

`public/icons/icon-{16,32,48,128}.png` are resized exports, made with macOS `sips -z SIZE SIZE autoffer-master.png --out OUTPUT`. No redraw or color editing was applied. PNG sizes are registered in the manifest for the extension and toolbar.

`src/ui/brand.ts` embeds the 128px PNG as a data URL for the popup and injected widget, avoiding extra network requests or web-accessible resources. Regenerate that data URL from the 128px PNG if the asset changes. UI corner radii are applied with CSS.
