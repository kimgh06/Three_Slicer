import { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { openableExtensions } from 'three-slicer-viewer/loaders'
import Prepare from '../../viewer/src/Prepare.jsx'
import '../../viewer/src/styles.css'
import { fetchIncomingFiles, INCOMING_ERRORS } from './incoming_file.js'
import { requestedFile } from './viewer_query.js'
import { targetNamed } from './targets.js'

// The extension's viewer tab is the demo app's /slice screen, built a second time with this folder's Vite config
// (the way rhwp's extension builds rhwp-studio): one slicer screen, two hosts.
// `files` is mount-only in <Viewport/>, so the requested file is fetched first and the screen mounts with it.

const request = requestedFile(window.location.search)
const TARGET = targetNamed(__TARGET__)

const noticeStyle = {
  position: 'fixed', left: '50%', top: '56px', transform: 'translateX(-50%)', zIndex: 10,
  background: '#1b2128', color: '#e6edf3', border: '1px solid #3a4450', borderRadius: '6px',
  padding: '8px 14px', font: '13px/1.4 system-ui, sans-serif', maxWidth: '80vw',
}
const buttonStyle = { marginLeft: '10px', font: 'inherit', cursor: 'pointer' }

async function fileAccessAllowed() {
  if (!TARGET.readsSavedFiles) return false
  try {
    return await chrome.extension.isAllowedFileSchemeAccess()
  } catch {
    return false
  }
}

function openExtensionSettings() {
  chrome.tabs.create({ url: TARGET.settingsUrl(chrome.runtime.id) })
}

function FailureNotice({ failure }) {
  if (failure.code === INCOMING_ERRORS.FILE_ACCESS_OFF) {
    return (
      <div style={noticeStyle} role="alert" data-testid="incoming-error" data-code={failure.code}>
        {failure.message}. Turn on “Allow access to file URLs” for Three Slicer, then open the download again.
        <button style={buttonStyle} onClick={openExtensionSettings}>Open extension settings</button>
      </div>
    )
  }
  return <div style={noticeStyle} role="alert" data-testid="incoming-error" data-code={failure.code}>Could not open the file: {failure.message}</div>
}

function ExtensionViewer() {
  const [state, setState] = useState(() => {
    if (request) return { status: 'loading' }
    return { status: 'ready', files: null }
  })
  useEffect(() => {
    if (!request) return
    fileAccessAllowed()
      .then((fileAccess) => fetchIncomingFiles(request, openableExtensions(), { fileAccess }))
      .then((files) => setState({ status: 'ready', files }))
      .catch((error) => setState({ status: 'failed', failure: { code: error.code, message: String(error?.message || error) } }))
  }, [])
  if (state.status === 'loading') {
    return <div style={{ ...noticeStyle, top: '50%' }} data-testid="incoming-loading">Loading {request.filename || request.url}…</div>
  }
  return <>
    <Prepare files={state.files} />
    {state.status === 'failed' && <FailureNotice failure={state.failure} />}
  </>
}

ReactDOM.createRoot(document.getElementById('root')).render(<ExtensionViewer />)
