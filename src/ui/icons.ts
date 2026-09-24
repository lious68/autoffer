const paths = {
  stop: 'M6 6h12v12H6V6Z',
  panel: 'M3 5h18v14H3V5Zm12 0v14M6 9h5M6 13h3',
  play: 'm8 5 11 7-11 7V5Z',
  pause: 'M8 5v14M16 5v14',
  orb: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM8 12h8M12 8v8',
  report: 'M8 3H5v18h14V7l-4-4H8Zm6 0v5h5M8 12h8M8 16h5',
  sliders: 'M4 7h5m4 0h7M4 17h9m4 0h3M9 4v6m4 4v6',
  shield: 'm12 3 8 3v5c0 5-8 10-8 10S4 16 4 11V6l8-3Zm-4 9 3 3 5-6',
  chevron: 'm9 5 7 7-7 7',
  check: 'm5 12 4 4L19 6',
  bolt: 'm13 2-9 12h7l-1 8 10-13h-7l1-7Z',
} as const;
export function icon(document: Document, name: keyof typeof paths) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', paths[name]);
  svg.append(path);
  return svg;
}
