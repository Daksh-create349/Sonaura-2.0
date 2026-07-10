# Privacy Policy for Sonaura 2.0

*Last Updated: July 2026*

Sonaura 2.0 ("the Extension") is committed to protecting your privacy. This Privacy Policy explains our data collection and usage practices.

## 1. No Data Collection or Transmission
Sonaura 2.0 does not collect, store, or transmit any personal data, audio recordings, browsing history, or system information.
- **Audio Processing:** All audio capture and digital signal processing (DSP) occur entirely locally and in real-time within your browser's execution memory. No audio stream is ever recorded, written to disk, or sent to any remote server.
- **Local Storage:** Custom preset profiles are stored exclusively on your local machine using the browser's local storage API (`chrome.storage.local`). They are never synchronized with external servers or shared with third parties.

## 2. Browser Permissions Requested
To perform its core functions, the Extension requests the following permissions:
- `tabCapture`: Necessary to capture the audio stream of the active tab in order to apply the digital signal processing chain (surround virtualization, reverb, and equalizer).
- `offscreen`: Used to create a helper offscreen page to run the Web Audio API context (required by Manifest V3).
- `storage`: Used to persist your custom equalizer and mixer presets locally.
- `activeTab`: Used to access and process audio on the specific tab you select when enabling the extension.

## 3. Changes to This Policy
We may update this Privacy Policy from time to time. Any changes will be posted directly within the repository.

## 4. Contact
If you have any questions or feedback regarding this policy, please open an issue in the project's official repository.
