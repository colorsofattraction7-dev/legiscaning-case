import { useEffect, useMemo, useRef, useState } from 'react';
import { openDB } from 'idb';
import {
  Activity,
  AlertCircle,
  ArrowDownToLine,
  ArrowUpRight,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Clock3,
  File,
  FileSearch,
  FileText,
  HardDrive,
  Inbox,
  Menu,
  MessageSquareText,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import './App.css';

const DOCUMENTS_KEY = 'briefcase-documents-v1';
const GOOGLE_CLIENT_KEY = 'briefcase-google-client-id';
const DATABASE_NAME = 'briefcase-workspace';
const GOOGLE_SCOPES = {
  drive: 'https://www.googleapis.com/auth/drive.readonly',
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
};
const MAX_TEXT_FILE_SIZE = 15 * 1024 * 1024;
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv', 'mpeg', 'mpg', '3gp'];

function readSavedDocuments() {
  try {
    const saved = JSON.parse(localStorage.getItem(DOCUMENTS_KEY) || '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function readSavedReviews() {
  try {
    const saved = JSON.parse(localStorage.getItem('briefcase-reviews-v1') || '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function getWorkspaceDb() {
  return openDB(DATABASE_NAME, 2, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('documents')) db.createObjectStore('documents', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('reviews')) db.createObjectStore('reviews', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', { keyPath: 'id' });
    },
  });
}

async function saveWorkspace(documents, reviews) {
  const db = await getWorkspaceDb();
  const transaction = db.transaction(['documents', 'reviews'], 'readwrite');
  await Promise.all([
    transaction.objectStore('documents').clear(),
    transaction.objectStore('reviews').clear(),
  ]);
  documents.forEach((document) => transaction.objectStore('documents').put(document));
  reviews.forEach((review) => transaction.objectStore('reviews').put(review));
  await transaction.done;
}

function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function createId() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readFile(file, mode) {
  const method = mode === 'text' ? 'readAsText' : 'readAsArrayBuffer';
  if (mode === 'text' && typeof file.text === 'function') return file.text();
  if (mode === 'buffer' && typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader[method](file);
  });
}

function makeDocumentReview(document, question) {
  const sentences = document.content
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 35);
  const terms = question
    .toLowerCase()
    .match(/[a-z0-9]{4,}/g)
    ?.filter((term) => !['what', 'does', 'this', 'that', 'with', 'from', 'have', 'about', 'document'].includes(term)) || [];
  const ranked = sentences
    .map((sentence, index) => ({
      sentence,
      index,
      score: terms.reduce((score, term) => score + (sentence.toLowerCase().includes(term) ? 1 : 0), 0),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 4);
  const passages = ranked.length ? ranked : sentences.slice(0, 3).map((sentence) => ({ sentence }));

  return {
    id: createId(),
    question,
    documentId: document.id,
    documentName: document.name,
    createdAt: new Date().toISOString(),
    passages: passages.map(({ sentence }) => sentence),
    contentLength: document.content.length,
  };
}

function decodeBase64Url(value) {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function extractText(file) {
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (file.type === 'application/pdf' || extension === 'pdf') {
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdf = await pdfjsLib.getDocument({ data: await readFile(file, 'buffer') }).promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const text = await page.getTextContent();
      pages.push(text.items.map((item) => item.str).join(' '));
    }
    return pages.join('\n\n');
  }
  if (extension === 'docx' || file.type.includes('wordprocessingml')) {
    const mammothModule = await import('mammoth/mammoth.browser');
    const mammoth = mammothModule.default || mammothModule;
    const result = await mammoth.extractRawText({ arrayBuffer: await readFile(file, 'buffer') });
    return result.value;
  }
  if (extension === 'rtf') {
    return (await readFile(file, 'text')).replace(/\\'[\da-f]{2}|\\[a-z]+-?\d* ?|[{}]/gi, ' ').replace(/\s+/g, ' ').trim();
  }
  if (file.type.startsWith('text/') || ['txt', 'md', 'csv', 'json'].includes(extension)) {
    return readFile(file, 'text');
  }
  throw new Error('Choose a PDF, DOCX, RTF, TXT, Markdown, CSV, or JSON file.');
}

async function loadGoogleIdentity() {
  if (window.google?.accounts?.oauth2) return;
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Google sign-in could not be loaded. Check your connection.'));
    document.head.appendChild(script);
  });
}

function App() {
  const fileInput = useRef(null);
  const hydrated = useRef(false);
  const [documents, setDocuments] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [activeView, setActiveView] = useState('desk');
  const [search, setSearch] = useState('');
  const [question, setQuestion] = useState('What are the key facts and deadlines?');
  const [reviews, setReviews] = useState([]);
  const [googleClientId, setGoogleClientId] = useState(() => localStorage.getItem(GOOGLE_CLIENT_KEY) || '');
  const [googleToken, setGoogleToken] = useState('');
  const [googleItems, setGoogleItems] = useState([]);
  const [googleSource, setGoogleSource] = useState('');
  const [modal, setModal] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState('');
  const [videoUrl, setVideoUrl] = useState('');

  const selectedDocument = documents.find((document) => document.id === selectedId) || null;
  const selectedIsVideo = selectedDocument?.kind === 'video';
  const visibleDocuments = useMemo(() => {
    const term = search.trim().toLowerCase();
    return documents.filter((document) => !term || `${document.name} ${document.source}`.toLowerCase().includes(term));
  }, [documents, search]);

  useEffect(() => {
    let cancelled = false;
    const loadWorkspace = async () => {
      try {
        const db = await getWorkspaceDb();
        let savedDocuments = await db.getAll('documents');
        let savedReviews = await db.getAll('reviews');
        if (!savedDocuments.length) {
          savedDocuments = readSavedDocuments();
          savedReviews = readSavedReviews();
          if (savedDocuments.length || savedReviews.length) {
            await saveWorkspace(savedDocuments, savedReviews);
            localStorage.removeItem(DOCUMENTS_KEY);
            localStorage.removeItem('briefcase-reviews-v1');
          }
        }
        if (!cancelled) {
          setDocuments((current) => {
            const existingIds = new Set(current.map((document) => document.id));
            return [...current, ...savedDocuments.filter((document) => !existingIds.has(document.id))];
          });
          setReviews((current) => {
            const existingIds = new Set(current.map((review) => review.id));
            return [...current, ...savedReviews.filter((review) => !existingIds.has(review.id))];
          });
          setSelectedId((current) => current || savedDocuments[0]?.id || null);
          hydrated.current = true;
        }
      } catch {
        if (!cancelled) setNotice('This browser could not open local storage. Check site storage permissions.');
      }
    };
    loadWorkspace();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    saveWorkspace(documents, reviews).catch(() => {
      setNotice('Could not save your workspace. Check available device storage.');
    });
  }, [documents, reviews]);

  useEffect(() => {
    let cancelled = false;
    let url = '';
    setVideoUrl('');
    if (!selectedIsVideo || !selectedDocument) return undefined;
    if (typeof URL.createObjectURL !== 'function') return undefined;
    getWorkspaceDb()
      .then((db) => db.get('media', selectedDocument.id))
      .then((media) => {
        if (cancelled || !media?.blob) return;
        url = URL.createObjectURL(media.blob);
        setVideoUrl(url);
      })
      .catch(() => {
        if (!cancelled) setNotice('Could not load this video from local storage.');
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [selectedDocument, selectedIsVideo]);

  const announce = (message) => {
    setNotice(message);
    window.setTimeout(() => setNotice(''), 5000);
  };

  const addFiles = async (files, source = 'Local upload') => {
    const batch = Array.from(files);
    if (!batch.length) return;
    setBusy(true);
    const imported = [];
    try {
      for (const file of batch) {
        const extension = file.name.split('.').pop()?.toLowerCase();
        const isVideo = file.type.startsWith('video/') || VIDEO_EXTENSIONS.includes(extension);
        if (!isVideo && file.size > MAX_TEXT_FILE_SIZE) {
          throw new Error(`${file.name} is over the 15 MB per-file limit for documents.`);
        }
        if (isVideo) {
          imported.push({
            id: createId(),
            name: file.name,
            type: file.type || 'video/mp4',
            kind: 'video',
            size: file.size,
            source,
            addedAt: new Date().toISOString(),
            content: '',
            fileBlob: file.slice(0, file.size, file.type),
          });
          continue;
        }
        const content = (await extractText(file)).trim();
        if (!content) throw new Error(`${file.name} has no extractable text. Scanned PDFs need OCR before review.`);
        imported.push({
          id: createId(),
          name: file.name,
          type: file.type || 'application/octet-stream',
          kind: 'document',
          size: file.size,
          source,
          addedAt: new Date().toISOString(),
          content,
        });
      }
      const db = await getWorkspaceDb();
      const transaction = db.transaction(['documents', 'media'], 'readwrite');
      imported.forEach((document) => {
        const { fileBlob, ...metadata } = document;
        transaction.objectStore('documents').put(metadata);
        if (fileBlob) transaction.objectStore('media').put({ id: document.id, blob: fileBlob });
      });
      await transaction.done;
      const metadata = imported.map(({ fileBlob, ...document }) => document);
      setDocuments((current) => [...metadata, ...current]);
      setSelectedId(metadata[0].id);
      setActiveView('documents');
      announce(`${metadata.length} ${metadata.length === 1 ? 'file' : 'files'} saved in this browser.`);
    } catch (error) {
      announce(error.message || 'The selected file could not be read.');
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const requestGoogleToken = async (scope) => {
    if (!googleClientId.trim()) {
      setModal('settings');
      announce('Add a Google OAuth client ID in settings to connect an account.');
      return null;
    }
    await loadGoogleIdentity();
    return new Promise((resolve, reject) => {
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: googleClientId.trim(),
        scope,
        callback: (response) => {
          if (response.error) reject(new Error(response.error_description || response.error));
          else {
            setGoogleToken(response.access_token);
            resolve(response.access_token);
          }
        },
        error_callback: (error) => reject(new Error(error.message || 'Google authorization was cancelled.')),
      });
      client.requestAccessToken({ prompt: 'consent' });
    });
  };

  const connectGoogle = async (source) => {
    setBusy(true);
    setGoogleSource(source);
    try {
      const token = await requestGoogleToken(GOOGLE_SCOPES[source]);
      if (!token) return;
      if (source === 'drive') {
        const response = await fetch('https://www.googleapis.com/drive/v3/files?orderBy=modifiedTime%20desc&pageSize=30&fields=files(id,name,mimeType,size,modifiedTime)&q=trashed%3Dfalse', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || 'Google Drive could not be read.');
        setGoogleItems((data.files || []).map((file) => ({ ...file, source: 'drive' })));
      } else {
        const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=25&q=has:attachment', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || 'Gmail could not be read.');
        const messages = await Promise.all((data.messages || []).slice(0, 15).map(async (message) => {
          const itemResponse = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}?format=full`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const item = await itemResponse.json();
          const headers = item.payload?.headers || [];
          const parts = [];
          const walk = (part) => {
            if (part.filename && (part.body?.attachmentId || part.body?.data)) parts.push({
              id: part.body.attachmentId,
              encoded: part.body.data,
              name: part.filename,
              mimeType: part.mimeType,
              messageId: message.id,
            });
            (part.parts || []).forEach(walk);
          };
          walk(item.payload || {});
          return parts.map((part) => ({
            ...part,
            source: 'gmail',
            subject: headers.find((header) => header.name.toLowerCase() === 'subject')?.value || 'Email attachment',
            sender: headers.find((header) => header.name.toLowerCase() === 'from')?.value || '',
          }));
        }));
        setGoogleItems(messages.flat());
      }
      setModal('google');
    } catch (error) {
      announce(error.message || `Could not connect to ${source === 'drive' ? 'Google Drive' : 'Gmail'}.`);
    } finally {
      setBusy(false);
    }
  };

  const importGoogleItem = async (item) => {
    if (!googleToken) {
      announce('Your Google session expired. Connect again to continue.');
      setModal('');
      return;
    }
    setBusy(true);
    try {
      let blob;
      let name = item.name;
      let mimeType = item.mimeType || 'text/plain';
      if (item.source === 'drive') {
        const isGoogleDoc = mimeType.startsWith('application/vnd.google-apps.');
        const endpoint = isGoogleDoc
          ? `https://www.googleapis.com/drive/v3/files/${item.id}/export?mimeType=text%2Fplain`
          : `https://www.googleapis.com/drive/v3/files/${item.id}?alt=media`;
        if (isGoogleDoc) name = `${name}.txt`;
        const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${googleToken}` } });
        if (!response.ok) throw new Error(`Could not download ${item.name} from Drive.`);
        blob = await response.blob();
      } else {
        let encoded = item.encoded;
        if (!encoded && item.id) {
          const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${item.messageId}/attachments/${item.id}`, {
            headers: { Authorization: `Bearer ${googleToken}` },
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error?.message || `Could not download ${item.name}.`);
          encoded = data.data;
        }
        blob = new Blob([decodeBase64Url(encoded || '')], { type: mimeType });
      }
      const file = new File([blob], name, { type: mimeType });
      await addFiles([file], item.source === 'drive' ? 'Google Drive' : 'Gmail');
    } catch (error) {
      announce(error.message || 'The Google file could not be imported.');
    } finally {
      setBusy(false);
    }
  };

  const runReview = (document = selectedDocument) => {
    if (!document) return;
    if (document.kind === 'video') {
      announce('Video footage is saved locally, but it must be transcribed before text-based evidence review.');
      return;
    }
    const review = makeDocumentReview(document, question.trim() || 'Summarize the key points');
    setReviews((current) => [review, ...current]);
    setActiveView('research');
  };

  const removeDocument = (id) => {
    getWorkspaceDb().then((db) => db.delete('media', id)).catch(() => {
      setNotice('Could not remove the stored video data.');
    });
    setDocuments((current) => current.filter((document) => document.id !== id));
    setReviews((current) => current.filter((review) => review.documentId !== id));
    if (selectedId === id) setSelectedId(documents.find((document) => document.id !== id)?.id || null);
  };

  const exportResearch = () => {
    const payload = JSON.stringify({ documents, reviews, exportedAt: new Date().toISOString() }, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'briefcase-research-export.json';
    link.click();
    URL.revokeObjectURL(url);
  };

  const switchView = (view) => setActiveView(view);

  return (
    <div className={`app-shell ${sidebarOpen ? 'sidebar-open' : ''}`}>
      {sidebarOpen ? <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} /> : null}
      <aside className="sidebar">
        <a className="brand" href="#desk" onClick={() => switchView('desk')}>
          <span className="brand-mark"><BookOpen size={19} /></span>
          <span><strong>Briefcase</strong><small>LEGAL WORKSPACE</small></span>
        </a>
        <div className="workspace-switch"><div className="workspace-avatar">L</div><span><b>Law office</b><small>Private workspace</small></span><ChevronDown size={15} /></div>
        <p className="nav-label">WORKSPACE</p>
        <nav className="side-nav" aria-label="Main navigation">
          <button className={activeView === 'desk' ? 'active' : ''} onClick={() => { switchView('desk'); setSidebarOpen(false); }}><Activity size={17} />Desk</button>
          <button className={activeView === 'documents' ? 'active' : ''} onClick={() => { switchView('documents'); setSidebarOpen(false); }}><FileText size={17} />Documents<span className="nav-count">{documents.length}</span></button>
          <button className={activeView === 'research' ? 'active' : ''} onClick={() => { switchView('research'); setSidebarOpen(false); }}><MessageSquareText size={17} />Research<span className="nav-count">{reviews.length}</span></button>
        </nav>
        <p className="nav-label source-label">ADD SOURCES</p>
        <div className="source-actions">
          <button onClick={() => fileInput.current?.click()}><Upload size={16} />Upload files</button>
          <button onClick={() => connectGoogle('gmail')} disabled={busy}><Inbox size={16} />Import from Gmail</button>
          <button onClick={() => connectGoogle('drive')} disabled={busy}><HardDrive size={16} />Import from Drive</button>
        </div>
        <div className="sidebar-bottom">
          <div className="privacy-card"><ShieldCheck size={17} /><span><b>Private by default</b><small>Files stay in this browser</small></span></div>
          <button className="settings-link" onClick={() => setModal('settings')}><Settings2 size={16} />Settings</button>
          <div className="profile"><div className="profile-avatar">JD</div><span><b>Workspace owner</b><small>Local account</small></span><ChevronDown size={15} /></div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <button className="mobile-menu" aria-label="Open menu" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen((open) => !open)}><Menu size={19} /></button>
          <div className="breadcrumbs"><span>Workspace</span><ChevronRight size={14} /><b>{activeView === 'desk' ? 'Desk' : activeView === 'documents' ? 'Documents' : 'Research'}</b></div>
          <div className="topbar-right"><span className="local-indicator"><span />Saved locally</span><button className="icon-button" aria-label="Settings" onClick={() => setModal('settings')}><Settings2 size={17} /></button></div>
        </header>

        <div className="page-content">
          {activeView === 'desk' ? (
            <>
              <section className="welcome-row">
                <div><p className="eyebrow">YOUR LEGAL WORKSPACE</p><h1>Good morning.</h1><p className="subheading">A clear place to organize documents and prepare grounded research.</p></div>
                <button className="primary-button" onClick={() => fileInput.current?.click()}><Plus size={17} />Add documents</button>
              </section>
              <section className="stat-row" aria-label="Workspace summary">
                <div className="stat-item"><span className="stat-icon blue"><FileText size={17} /></span><span><small>Documents</small><b>{documents.length}</b></span></div>
                <div className="stat-item"><span className="stat-icon green"><FileSearch size={17} /></span><span><small>Research notes</small><b>{reviews.length}</b></span></div>
                <div className="stat-item"><span className="stat-icon gold"><Clock3 size={17} /></span><span><small>Last added</small><b>{documents[0] ? new Date(documents[0].addedAt).toLocaleDateString() : 'Not yet'}</b></span></div>
                <div className="stat-item"><span className="stat-icon violet"><ShieldCheck size={17} /></span><span><small>Storage</small><b>This device</b></span></div>
              </section>
              <div className="dashboard-grid">
                <section className="panel document-panel">
                  <div className="panel-heading"><div><h2>Recent documents</h2><p>Your files and connected sources</p></div><button className="text-button" onClick={() => switchView('documents')}>View all <ArrowUpRight size={14} /></button></div>
                  {documents.length ? <div className="document-list">{documents.slice(0, 5).map((document) => <DocumentRow key={document.id} document={document} onSelect={() => { setSelectedId(document.id); switchView('documents'); }} />)}</div> : <EmptyDocuments onUpload={() => fileInput.current?.click()} />}
                </section>
                <section className="panel quick-panel">
                  <div className="panel-heading"><div><h2>Start with a source</h2><p>Add material to your workspace</p></div><span className="sparkle-mark"><Sparkles size={16} /></span></div>
                  <button className="quick-action" onClick={() => fileInput.current?.click()}><span className="quick-icon upload-icon"><Upload size={17} /></span><span><b>Upload from device</b><small>PDF, Word, text and more</small></span><ChevronRight size={16} /></button>
                  <button className="quick-action" onClick={() => connectGoogle('gmail')}><span className="quick-icon gmail-icon"><Inbox size={17} /></span><span><b>Find an email attachment</b><small>Read-only Gmail access</small></span><ChevronRight size={16} /></button>
                  <button className="quick-action" onClick={() => connectGoogle('drive')}><span className="quick-icon drive-icon"><HardDrive size={17} /></span><span><b>Choose from Google Drive</b><small>Read-only Drive access</small></span><ChevronRight size={16} /></button>
                  <div className="quiet-note"><ShieldCheck size={14} />Google access is read-only. Imported files are saved in this browser.</div>
                </section>
              </div>
              <section className="panel research-panel">
                <div className="panel-heading"><div><h2>Recent research</h2><p>Document-specific notes and extracted evidence</p></div><button className="text-button" onClick={() => switchView('research')}>Open research <ArrowUpRight size={14} /></button></div>
                {reviews.length ? <div className="research-list">{reviews.slice(0, 3).map((review) => <ResearchRow key={review.id} review={review} />)}</div> : <div className="empty-research"><div className="empty-icon"><MessageSquareText size={19} /></div><div><b>No research notes yet</b><p>Choose a document and ask a question to extract relevant passages.</p></div></div>}
              </section>
            </>
          ) : null}

          {activeView === 'documents' ? (
            <section className="workspace-view">
              <div className="view-title"><div><p className="eyebrow">YOUR MATERIAL</p><h1>Documents</h1><p className="subheading">Text is extracted in your browser and stays on this device.</p></div><button className="primary-button" onClick={() => fileInput.current?.click()}><Upload size={16} />Upload files</button></div>
              <div className="documents-layout">
                <section className="panel file-browser">
                  <div className="file-toolbar"><div className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search files" /></div><span className="result-count">{visibleDocuments.length} files</span></div>
                  <div className="file-list">{visibleDocuments.length ? visibleDocuments.map((document) => <DocumentRow key={document.id} document={document} selected={selectedId === document.id} onSelect={() => setSelectedId(document.id)} />) : <EmptyDocuments onUpload={() => fileInput.current?.click()} compact />}</div>
                  <div className={`drop-zone ${dragging ? 'is-dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }}>
                    <Upload size={17} /><span>Drop files here or <button onClick={() => fileInput.current?.click()}>browse</button></span>
                  </div>
                </section>
                <section className="panel document-detail">
                  {selectedDocument ? <>
                    <div className="detail-top"><span className="detail-file-icon">{selectedIsVideo ? <File size={20} /> : <FileText size={20} />}</span><button className="icon-button" aria-label="Remove document" onClick={() => removeDocument(selectedDocument.id)}><X size={16} /></button></div>
                    <h2 className="detail-title">{selectedDocument.name}</h2><div className="detail-meta">{formatBytes(selectedDocument.size)} <span>·</span> {selectedDocument.source} <span>·</span> Added {new Date(selectedDocument.addedAt).toLocaleDateString()}</div>
                    <div className="detail-rule" />
                    {selectedIsVideo ? <>
                      {videoUrl ? <video className="video-preview" controls preload="metadata" src={videoUrl}>Video playback is not supported by this browser.</video> : null}
                      <div className="video-notice"><b>Footage saved on this device</b><p>Video is stored locally without a file-size cap from this app. Available browser storage varies by device. To search or review spoken content, create a transcript and add it as a document.</p></div>
                    </> : <>
                      <div className="content-preview-heading"><b>Extracted text</b><span>{selectedDocument.content.length.toLocaleString()} characters</span></div>
                      <p className="content-preview">{selectedDocument.content.slice(0, 1800)}{selectedDocument.content.length > 1800 ? '…' : ''}</p>
                      <div className="review-prompt"><label htmlFor="document-question">Ask about this document</label><textarea id="document-question" value={question} onChange={(event) => setQuestion(event.target.value)} rows={3} /><button className="primary-button full-button" onClick={() => runReview()}><Sparkles size={16} />Find relevant evidence</button><small>Returns matching passages from this file; it does not generate legal advice.</small></div>
                    </>}
                  </> : <EmptyDocuments onUpload={() => fileInput.current?.click()} compact />}
                </section>
              </div>
            </section>
          ) : null}

          {activeView === 'research' ? (
            <section className="workspace-view">
              <div className="view-title"><div><p className="eyebrow">SOURCE-BASED NOTES</p><h1>Research</h1><p className="subheading">Answers show passages from your files, not unsupported legal conclusions.</p></div><button className="secondary-button" onClick={exportResearch}><ArrowDownToLine size={16} />Export research</button></div>
              {reviews.length ? <div className="research-list full-research-list">{reviews.map((review) => <ResearchCard key={review.id} review={review} onOpen={() => { setSelectedId(review.documentId); setActiveView('documents'); }} />)}</div> : <section className="panel research-empty-panel"><div className="empty-icon large"><MessageSquareText size={22} /></div><h2>No notes saved</h2><p>Add a document, ask a question, and save the matching passages here.</p><button className="primary-button" onClick={() => switchView('documents')}><FileText size={16} />Open documents</button></section>}
              <div className="legal-caveat"><AlertCircle size={16} /><span><b>Research limitation</b> These notes quote matching text only. They are not a legal analysis, and source text should be checked against the original document and current law.</span></div>
            </section>
          ) : null}
        </div>
      </main>

      <input ref={fileInput} className="visually-hidden" type="file" multiple accept=".pdf,.docx,.rtf,.txt,.md,.csv,.json,video/*,.mp4,.mov,.m4v,.webm,.avi,.mkv,.mpeg,.mpg,.3gp" onChange={(event) => addFiles(event.target.files)} />
      {busy ? <div className="busy-indicator"><span className="spinner" />{googleSource ? `Connecting to ${googleSource === 'drive' ? 'Drive' : 'Gmail'}…` : 'Reading files…'}</div> : null}
      {notice ? <div className="toast" role="status"><AlertCircle size={17} />{notice}<button aria-label="Dismiss" onClick={() => setNotice('')}><X size={15} /></button></div> : null}

      {modal === 'settings' ? <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setModal(''); }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="modal-header"><div><p className="eyebrow">CONNECTIONS</p><h2 id="settings-title">Google access</h2></div><button className="icon-button" aria-label="Close settings" onClick={() => setModal('')}><X size={17} /></button></div><p className="modal-copy">Enter a Google OAuth 2.0 web client ID to enable read-only Gmail and Drive imports. Google requires an OAuth consent screen and this app's origin added as an authorized JavaScript origin.</p><label className="form-label" htmlFor="google-client-id">OAuth client ID</label><input id="google-client-id" className="text-input" value={googleClientId} onChange={(event) => setGoogleClientId(event.target.value)} placeholder="123456789.apps.googleusercontent.com" /><div className="modal-actions"><button className="secondary-button" onClick={() => setModal('')}>Cancel</button><button className="primary-button" onClick={() => { localStorage.setItem(GOOGLE_CLIENT_KEY, googleClientId.trim()); setModal(''); announce(googleClientId.trim() ? 'Google client ID saved in this browser.' : 'Google client ID removed.'); }}>Save setting</button></div><div className="integration-note"><ShieldCheck size={16} />Tokens are held in memory only. Access is requested per provider and can be revoked in your Google account.</div></section></div> : null}

      {modal === 'google' ? <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setModal(''); }}><section className="modal google-modal" role="dialog" aria-modal="true" aria-labelledby="google-title"><div className="modal-header"><div><p className="eyebrow">{googleSource === 'drive' ? 'GOOGLE DRIVE' : 'GMAIL ATTACHMENTS'}</p><h2 id="google-title">Choose a file</h2></div><button className="icon-button" aria-label="Close file picker" onClick={() => setModal('')}><X size={17} /></button></div><p className="modal-copy">Select an item to copy its contents into this browser's document workspace.</p><div className="google-file-list">{googleItems.length ? googleItems.map((item, index) => <button className="google-file" key={`${item.id}-${index}`} onClick={() => importGoogleItem(item)} disabled={busy}><span className="file-type-icon"><File size={17} /></span><span><b>{item.name || item.subject}</b><small>{item.source === 'gmail' ? `${item.subject} · ${item.sender}` : `${item.mimeType} · ${item.modifiedTime ? new Date(item.modifiedTime).toLocaleDateString() : ''}`}</small></span><ArrowDownToLine size={16} /></button>) : <div className="no-google-files">No importable files found. {googleSource === 'gmail' ? 'Emails without attachments are not listed.' : 'Try uploading a local copy.'}</div>}</div><div className="modal-actions"><button className="secondary-button" onClick={() => connectGoogle(googleSource)} disabled={busy}>Refresh list</button><button className="text-button" onClick={() => { setModal(''); setModal('settings'); }}>Google settings <ArrowUpRight size={14} /></button></div></section></div> : null}
    </div>
  );
}

function DocumentRow({ document, selected, onSelect }) {
  const extension = document.name.split('.').pop()?.toUpperCase() || 'FILE';
  return <button className={`document-row ${selected ? 'selected' : ''}`} onClick={onSelect}><span className="file-type-icon">{extension === 'PDF' ? <FileText size={17} /> : <File size={17} />}</span><span className="document-row-main"><b>{document.name}</b><small>{document.source} · {formatBytes(document.size)}</small></span><ChevronRight size={15} className="row-chevron" /></button>;
}

function EmptyDocuments({ onUpload, compact }) {
  return <div className={`empty-documents ${compact ? 'compact' : ''}`}><div className="empty-icon"><Upload size={19} /></div><b>No documents yet</b><p>Upload a document or video file to begin.</p><button className="secondary-button" onClick={onUpload}><Upload size={15} />Choose files</button></div>;
}

function ResearchRow({ review }) {
  return <article className="research-row"><span className="research-row-icon"><MessageSquareText size={16} /></span><div><b>{review.question}</b><p>{review.documentName} <span>·</span> {new Date(review.createdAt).toLocaleDateString()}</p></div><ChevronRight size={15} /></article>;
}

function ResearchCard({ review, onOpen }) {
  return <article className="panel research-card"><div className="research-card-heading"><span className="research-row-icon"><MessageSquareText size={16} /></span><div><h2>{review.question}</h2><p><FileText size={13} />{review.documentName}<span>·</span>{new Date(review.createdAt).toLocaleString()}</p></div><button className="text-button" onClick={onOpen}>Open file <ArrowUpRight size={14} /></button></div><div className="passage-list">{review.passages.length ? review.passages.map((passage, index) => <blockquote key={`${review.id}-${index}`}><span>Passage {index + 1}</span>{passage}</blockquote>) : <p>No matching text passages were extracted.</p>}</div><div className="research-footnote"><ShieldCheck size={14} />{review.contentLength.toLocaleString()} characters reviewed · Verify quotations against the original file</div></article>;
}

export default App;
