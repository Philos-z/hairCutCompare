# Browser inference fixture

`white-house-portrait.jpg` is the reduced official portrait of Barack Obama photographed by Pete Souza / The White House on 6 December 2012. It is used only for reproducible local algorithm tests, not as an endorsement or app demonstration.

- Downloaded test-image source: https://storage.googleapis.com/mediapipe-assets/portrait.jpg
- Original photograph and attribution: https://commons.wikimedia.org/wiki/File:President_Barack_Obama.jpg
- License: public domain as work of an employee of the U.S. Executive Office of the President during official duties; the original file page explicitly records this status.
- Primary policy: https://obamawhitehouse.archives.gov/copyright
- Fixture modifications: Google's reduced JPEG is retained byte for byte (820 × 1024).

Real-portrait inference checks are plumbing and visual-coordinate regression tests. They do not establish haircut segmentation accuracy across styles, lighting, or devices. Synthetic masks in `src/analysis/geometry.test.ts` cover the separate open outer arch and lower fringe boundary.
