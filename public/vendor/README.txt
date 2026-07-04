Vendored AR libraries (FASE 1 viewer). Download these three files into THIS
folder on your machine (the sandbox cannot reach the registry/CDNs):

PowerShell (from the repo root):

  iwr https://aframe.io/releases/1.4.2/aframe.min.js -OutFile public/vendor/aframe.min.js
  iwr https://cdn.jsdelivr.net/npm/aframe-extras@7.2.0/dist/aframe-extras.min.js -OutFile public/vendor/aframe-extras.min.js
  iwr https://cdn.jsdelivr.net/gh/AR-js-org/AR.js@3.4.5/aframe/build/aframe-ar.js -OutFile public/vendor/aframe-ar.js

Load order (handled by ar-scene.service): aframe -> aframe-extras -> aframe-ar.
aframe-ar.js covers PATTERN markers + LOCATION-BASED (gps). NFT markers would
need aframe-ar-nft.js instead (not used in FASE 1).
Versions are pinned on purpose (decision F1-2: no CDN at runtime).
