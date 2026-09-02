const fs = require('fs');
const path = require('path');

const iconsDir = path.join(__dirname, '../../frontend/public/icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

// Generate an SVG and save as icon.svg and fallback icons
const svgIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#3b82f6" />
      <stop offset="100%" stop-color="#1d4ed8" />
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="128" fill="url(#grad)" />
  <path d="M160 160h192v64H224v32h128v64H224v64h-64V160z" fill="#ffffff" />
  <circle cx="360" cy="350" r="30" fill="#10b981" />
</svg>`;

fs.writeFileSync(path.join(iconsDir, 'icon.svg'), svgIcon);
// Also create simple placeholder binary files or copy svg for 192 and 512
fs.writeFileSync(path.join(iconsDir, 'icon-192.png'), svgIcon);
fs.writeFileSync(path.join(iconsDir, 'icon-512.png'), svgIcon);

console.log('Icons generated successfully');
