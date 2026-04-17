import { useState, useEffect, useRef, useCallback } from 'react';
import { doc, getDoc, setDoc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import CryptoJS from 'crypto-js';

const CLOUD_FUNCTIONS_URL = '***REMOVED***';

// ─── Iconos SVG ─────────────────────────────────────────────────────────────
const SendIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
  </svg>
);
const TrashIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);
const SparkleIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
  </svg>
);
const SettingsIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);
const CheckIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);
const AlertTriangleIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);
const BotIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="10" rx="2" /><circle cx="12" cy="5" r="2" /><path d="M12 7v4" /><line x1="8" y1="16" x2="8" y2="16" /><line x1="16" y1="16" x2="16" y2="16" />
  </svg>
);
const SaveIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" />
  </svg>
);
const TestIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
  </svg>
);
const EyeIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
  </svg>
);
const EyeOffIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);
const PlusIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);
const XIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);
const BrainIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2a7 7 0 0 1 4 12.7V17H8v-2.3A7 7 0 0 1 12 2z" /><path d="M9 18h6" /><path d="M10 22h4" />
  </svg>
);
const FileTextIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" />
  </svg>
);
const ChevronIcon = ({ size = 12, open }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transition: 'transform 0.2s', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>
    <polyline points="9 18 15 12 9 6" />
  </svg>
);
const TelegramIcon = ({ size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" opacity="0.6">
    <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
  </svg>
);

// ─── Modelos base (siempre disponibles) ────────────────────────────────────
const BASE_MODELS = [
  { value: 'gemini-pro-latest', label: 'Gemini Pro (Latest)' },
  { value: 'gemini-flash-latest', label: 'Gemini Flash (Latest)' },
  { value: 'gemini-flash-lite-latest', label: 'Gemini Flash Lite (Latest)' },
];

const THINKING_LEVELS = [
  { value: 'none', label: 'Ninguno' },
  { value: 'low', label: 'Bajo' },
  { value: 'medium', label: 'Medio' },
  { value: 'high', label: 'Alto' },
];

// ─── Formateo ───────────────────────────────────────────────────────────────
function formatTime(date) {
  return new Date(date).toLocaleString('es-MX', {
    hour: '2-digit', minute: '2-digit',
  });
}

function formatMessageText(text) {
  if (!text) return '';
  let html = text
    .replace(/```([\s\S]*?)```/g, '<pre class="chat-code-block">$1</pre>')
    .replace(/`([^`]+)`/g, '<code class="chat-inline-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br/>');
  return html;
}

// ─── Componente principal ───────────────────────────────────────────────────

export default function ChatAI() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [aiSettings, setAiSettings] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState('info'); // 'info' | 'config' | 'models' | 'prompts'
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [showApiKey, setShowApiKey] = useState(false);
  // Editable settings form
  const [editApiKey, setEditApiKey] = useState('');
  const [editChatModel, setEditChatModel] = useState('');
  const [editAnalysisModel, setEditAnalysisModel] = useState('');
  const [editTemperature, setEditTemperature] = useState(0.3);
  const [editThinking, setEditThinking] = useState('low');
  const [editEnabled, setEditEnabled] = useState(false);
  const [editChatEnabled, setEditChatEnabled] = useState(true);
  const [editAnalysisEnabled, setEditAnalysisEnabled] = useState(true);
  // Custom models
  const [customModels, setCustomModels] = useState([]);
  const [newModelId, setNewModelId] = useState('');
  const [newModelLabel, setNewModelLabel] = useState('');
  const [addingModel, setAddingModel] = useState(false);
  // Prompts
  const [promptsData, setPromptsData] = useState(null);
  const [editChatPrompt, setEditChatPrompt] = useState('');
  const [editAnalysisPrompt, setEditAnalysisPrompt] = useState('');
  const [useCustomChat, setUseCustomChat] = useState(false);
  const [useCustomAnalysis, setUseCustomAnalysis] = useState(false);
  const [savingPrompts, setSavingPrompts] = useState(false);
  const [promptView, setPromptView] = useState('chat'); // 'chat' | 'analysis'
  // Thinking visibility per message
  const [expandedThinking, setExpandedThinking] = useState({});
  // API Key PIN security
  const [apiKeyUnlocked, setApiKeyUnlocked] = useState(false);
  const [apiKeyPinInput, setApiKeyPinInput] = useState('');
  const [apiKeyPinError, setApiKeyPinError] = useState('');

  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const textareaRef = useRef(null);

  // ─── Merge modelos: base + custom ─────────────────────────────────
  const allModels = [...BASE_MODELS];
  customModels.forEach(cm => {
    if (!allModels.some(m => m.value === cm.value)) {
      allModels.push({ value: cm.value, label: cm.label || cm.value });
    }
  });

  // ─── Cargar datos al montar + listener en tiempo real ──────────────
  useEffect(() => {
    // Cargar AI settings
    const loadSettings = async () => {
      try {
        const res = await fetch(`${CLOUD_FUNCTIONS_URL}/get_ai_settings`);
        const data = await res.json();
        setAiSettings(data);
        setCustomModels(data.customModels || []);
        _syncEditForm(data);
      } catch (err) {
        console.error('Error cargando settings del chat:', err);
      }
    };
    loadSettings();

    // Listener en tiempo real para sincronizar mensajes (Telegram ↔ Dashboard)
    const unsub = onSnapshot(doc(db, 'chat', 'history'), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        setMessages(data.messages || []);
      }
    }, (err) => {
      console.error('Error en listener de chat:', err);
    });

    return () => unsub();
  }, []);

  const _syncEditForm = (data) => {
    setEditChatModel(data.chatModel || data.model || 'gemini-3.1-flash-lite-preview');
    setEditAnalysisModel(data.analysisModel || data.model || 'gemini-3.1-flash-lite-preview');
    setEditTemperature(data.temperature ?? 0.3);
    setEditThinking(data.thinkingLevel || 'low');
    setEditEnabled(data.enabled ?? false);
    setEditChatEnabled(data.chatEnabled !== false);
    setEditAnalysisEnabled(data.analysisEnabled !== false);
    setEditApiKey('');
  };

  // ─── Auto-scroll ────────────────────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ─── Enviar mensaje ─────────────────────────────────────────────────
  const handleSend = async () => {
    const msg = input.trim();
    if (!msg || loading) return;

    // Agregar mensaje del usuario localmente (optimistic UI)
    const userMessage = { role: 'user', content: msg, source: 'dashboard', timestamp: new Date().toISOString() };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput('');
    setLoading(true);

    if (textareaRef.current) textareaRef.current.style.height = '44px';

    try {
      // Timeout de 160s (la Cloud Function tiene 180s de timeout)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 160000);

      // El backend lee/guarda el historial compartido, solo enviamos el mensaje
      const res = await fetch(`${CLOUD_FUNCTIONS_URL}/chat_ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, includeContext: true }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const data = await res.json();

      if (data.error === true) {
        // Solo en caso de error, agregar mensaje local (no se guardó en backend)
        const errMsg = { role: 'assistant', content: data.response || 'Error desconocido',
                         timestamp: new Date().toISOString(), error: true };
        setMessages(prev => [...prev, errMsg]);
      }
      // Si fue exitoso, el onSnapshot se encargará de actualizar los mensajes
    } catch (err) {
      const isTimeout = err.name === 'AbortError';
      const errContent = isTimeout
        ? '⏱️ La solicitud tardó demasiado (>2.5 min). La IA puede estar ejecutando muchas herramientas. Intenta de nuevo o simplifica la solicitud.'
        : `Error de conexión: ${err.message}`;
      const errMsg = { role: 'assistant', content: errContent,
                       timestamp: new Date().toISOString(), error: true };
      setMessages(prev => [...prev, errMsg]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleClear = async () => {
    if (!window.confirm('Limpiar todo el historial del chat?')) return;
    setMessages([]);
    try { await setDoc(doc(db, 'chat', 'history'), { messages: [], updatedAt: new Date().toISOString() }); } catch (e) { /* ok */ }
  };

  const handleTextareaInput = (e) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = '44px';
    el.style.height = Math.min(el.scrollHeight, 150) + 'px';
  };

  // ─── Guardar configuracion ────────────────────────────────────────
  const handleSaveSettings = async () => {
    setSaving(true);
    try {
      const payload = {
        model: editChatModel,
        chatModel: editChatModel,
        analysisModel: editAnalysisModel,
        temperature: editTemperature,
        thinkingLevel: editThinking,
        enabled: editEnabled,
        chatEnabled: editChatEnabled,
        analysisEnabled: editAnalysisEnabled,
      };
      if (editApiKey.trim()) payload.apiKey = editApiKey.trim();

      const res = await fetch(`${CLOUD_FUNCTIONS_URL}/update_ai_settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await res.json();
      if (result.success) {
        const res2 = await fetch(`${CLOUD_FUNCTIONS_URL}/get_ai_settings`);
        const data2 = await res2.json();
        setAiSettings(data2);
        setCustomModels(data2.customModels || []);
        _syncEditForm(data2);
        setEditApiKey('');
      } else {
        alert('Error guardando: ' + (result.error || 'desconocido'));
      }
    } catch (err) {
      alert('Error de conexion: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  // ─── Test de conexion ─────────────────────────────────────────────
  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`${CLOUD_FUNCTIONS_URL}/test_ai`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await res.json();
      setTestResult(data);
    } catch (err) {
      setTestResult({ success: false, message: err.message });
    } finally {
      setTesting(false);
    }
  };

  // ─── Gestionar modelos ────────────────────────────────────────────
  const handleAddModel = async () => {
    if (!newModelId.trim()) return;
    setAddingModel(true);
    try {
      const res = await fetch(`${CLOUD_FUNCTIONS_URL}/manage_ai_models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', modelId: newModelId.trim(), modelLabel: newModelLabel.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        setCustomModels(data.models);
        setNewModelId('');
        setNewModelLabel('');
      } else {
        alert(data.error || 'Error');
      }
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      setAddingModel(false);
    }
  };

  const handleRemoveModel = async (modelId) => {
    if (!window.confirm(`Eliminar modelo "${modelId}" de la lista?`)) return;
    try {
      const res = await fetch(`${CLOUD_FUNCTIONS_URL}/manage_ai_models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove', modelId }),
      });
      const data = await res.json();
      if (data.success) setCustomModels(data.models);
    } catch (err) {
      alert('Error: ' + err.message);
    }
  };

  // ─── Gestionar prompts ────────────────────────────────────────────
  const loadPrompts = async () => {
    try {
      const res = await fetch(`${CLOUD_FUNCTIONS_URL}/get_ai_prompts`);
      const data = await res.json();
      setPromptsData(data);
      setEditChatPrompt(data.customChatPrompt || '');
      setEditAnalysisPrompt(data.customAnalysisPrompt || '');
      setUseCustomChat(data.useCustomChat || false);
      setUseCustomAnalysis(data.useCustomAnalysis || false);
    } catch (err) {
      console.error('Error cargando prompts:', err);
    }
  };

  const handleSavePrompts = async () => {
    setSavingPrompts(true);
    try {
      const res = await fetch(`${CLOUD_FUNCTIONS_URL}/update_ai_prompts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatPrompt: editChatPrompt,
          analysisPrompt: editAnalysisPrompt,
          useCustomChat,
          useCustomAnalysis,
        }),
      });
      const data = await res.json();
      if (!data.success) alert('Error: ' + (data.error || 'desconocido'));
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      setSavingPrompts(false);
    }
  };

  const toggleThinking = (idx) => {
    setExpandedThinking(prev => ({ ...prev, [idx]: !prev[idx] }));
  };

  const isEnabled = aiSettings?.enabled && aiSettings?.chatEnabled !== false;

  // Cuando se abre la pestana de prompts, cargar
  useEffect(() => {
    if (settingsTab === 'prompts' && !promptsData) loadPrompts();
  }, [settingsTab]);

  return (
    <div className="chat-ai-page">
      {/* Header */}
      <div className="chat-ai-header">
        <div className="chat-ai-header-left">
          <div className="chat-ai-header-icon"><SparkleIcon size={18} /></div>
          <div>
            <h2 className="chat-ai-title">Chat IA</h2>
            <span className="chat-ai-subtitle">Asistente inteligente con Gemini</span>
          </div>
        </div>
        <div className="chat-ai-header-actions">
          <button className={`chat-toolbar-btn ${settingsOpen ? 'active' : ''}`} onClick={() => setSettingsOpen(!settingsOpen)} title="Configuracion">
            <SettingsIcon size={15} />
          </button>
          {messages.length > 0 && (
            <button className="chat-toolbar-btn chat-toolbar-btn-danger" onClick={handleClear} title="Limpiar historial">
              <TrashIcon size={15} />
            </button>
          )}
        </div>
      </div>

      {/* Settings panel */}
      {settingsOpen && (
        <div className="chat-config-panel">
          <div className="chat-config-tabs">
            <button className={`chat-config-tab ${settingsTab === 'info' ? 'active' : ''}`} onClick={() => setSettingsTab('info')}>Estado</button>
            <button className={`chat-config-tab ${settingsTab === 'config' ? 'active' : ''}`} onClick={() => setSettingsTab('config')}>Config</button>
            <button className={`chat-config-tab ${settingsTab === 'models' ? 'active' : ''}`} onClick={() => setSettingsTab('models')}>Modelos</button>
            <button className={`chat-config-tab ${settingsTab === 'prompts' ? 'active' : ''}`} onClick={() => setSettingsTab('prompts')}>Prompts</button>
          </div>

          {/* ─── Pestana: Estado ───────────────────────────────────── */}
          {settingsTab === 'info' && aiSettings && (
            <div className="chat-config-body">
              <div className="chat-config-grid">
                <div className="chat-config-stat">
                  <span className="chat-config-stat-label">Estado IA</span>
                  <span className={`chat-config-badge ${isEnabled ? 'on' : 'off'}`}>
                    {isEnabled ? 'Activo' : 'Inactivo'}
                  </span>
                </div>
                <div className="chat-config-stat">
                  <span className="chat-config-stat-label">Modelo de chat</span>
                  <span className="chat-config-stat-value">{aiSettings.chatModel || aiSettings.model || '--'}</span>
                </div>
                <div className="chat-config-stat">
                  <span className="chat-config-stat-label">Modelo de analisis</span>
                  <span className="chat-config-stat-value">{aiSettings.analysisModel || aiSettings.model || '--'}</span>
                </div>
                <div className="chat-config-stat">
                  <span className="chat-config-stat-label">API Key</span>
                  <span className="chat-config-stat-value">{aiSettings.apiKeySet ? aiSettings.apiKeyMasked : 'No configurada'}</span>
                </div>
                <div className="chat-config-stat">
                  <span className="chat-config-stat-label">Temperatura</span>
                  <span className="chat-config-stat-value">{aiSettings.temperature ?? '--'}</span>
                </div>
                <div className="chat-config-stat">
                  <span className="chat-config-stat-label">Razonamiento</span>
                  <span className="chat-config-stat-value">{aiSettings.thinkingLevel || 'none'}</span>
                </div>
              </div>
              <div className="chat-config-actions">
                <button className="chat-config-action-btn" onClick={handleTestConnection} disabled={testing}>
                  <TestIcon size={14} /> {testing ? 'Probando...' : 'Probar conexion'}
                </button>
              </div>
              {testResult && (
                <div className={`chat-test-result ${testResult.success ? 'success' : 'error'}`}>
                  {testResult.success ? <CheckIcon size={14} /> : <AlertTriangleIcon size={14} />}
                  <span>{testResult.message}</span>
                </div>
              )}
            </div>
          )}

          {/* ─── Pestana: Configuracion ───────────────────────────── */}
          {settingsTab === 'config' && (
            <div className="chat-config-body">
              {/* API Key (protegida por PIN de Bóveda) */}
              <div className="chat-config-field">
                <label className="chat-config-label">API Key de Gemini</label>
                {!apiKeyUnlocked ? (
                  <div className="chat-config-pin-gate">
                    <div className="chat-config-pin-row">
                      <input
                        type="password"
                        className="chat-config-input"
                        placeholder="PIN de Bóveda para editar"
                        value={apiKeyPinInput}
                        maxLength={4}
                        onChange={e => {
                          const val = e.target.value.replace(/\D/g, '');
                          setApiKeyPinInput(val);
                          setApiKeyPinError('');
                          if (val.length === 4) {
                            // Verificar PIN
                            (async () => {
                              try {
                                const pinDoc = await getDoc(doc(db, 'config', 'vault-security'));
                                if (pinDoc.exists() && pinDoc.data().pinHash) {
                                  const hash = CryptoJS.SHA256(val + '_AdminLank_VaultPIN_2026').toString();
                                  if (hash === pinDoc.data().pinHash) {
                                    setApiKeyUnlocked(true);
                                    setApiKeyPinInput('');
                                    setApiKeyPinError('');
                                  } else {
                                    setApiKeyPinError('PIN incorrecto');
                                    setApiKeyPinInput('');
                                  }
                                } else {
                                  // No hay PIN configurado, desbloquear
                                  setApiKeyUnlocked(true);
                                  setApiKeyPinInput('');
                                }
                              } catch {
                                setApiKeyPinError('Error verificando PIN');
                                setApiKeyPinInput('');
                              }
                            })();
                          }
                        }}
                      />
                      <span className="chat-config-pin-icon">🔒</span>
                    </div>
                    {apiKeyPinError && <span className="chat-config-hint" style={{ color: 'var(--error-color, #ef4444)' }}>{apiKeyPinError}</span>}
                    <span className="chat-config-hint">Ingresa el PIN de Bóveda para editar la API Key</span>
                    {aiSettings?.apiKeySet && <span className="chat-config-hint">Actual: {aiSettings.apiKeyMasked}</span>}
                  </div>
                ) : (
                  <>
                    <div className="chat-config-input-row">
                      <input
                        type={showApiKey ? 'text' : 'password'}
                        className="chat-config-input"
                        placeholder={aiSettings?.apiKeySet ? 'Dejar vacio para mantener actual' : 'Ingresa tu API Key'}
                        value={editApiKey}
                        onChange={e => setEditApiKey(e.target.value)}
                      />
                      <button className="chat-config-input-btn" onClick={() => setShowApiKey(!showApiKey)} title={showApiKey ? 'Ocultar' : 'Mostrar'}>
                        {showApiKey ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
                      </button>
                      <button className="chat-config-input-btn" onClick={() => { setApiKeyUnlocked(false); setEditApiKey(''); }} title="Bloquear">
                        🔒
                      </button>
                    </div>
                    {aiSettings?.apiKeySet && <span className="chat-config-hint">Actual: {aiSettings.apiKeyMasked}</span>}
                  </>
                )}
              </div>

              {/* Toggles */}
              <div className="chat-config-toggles">
                <label className="chat-config-toggle">
                  <input type="checkbox" checked={editEnabled} onChange={e => setEditEnabled(e.target.checked)} />
                  <span>IA habilitada</span>
                </label>
                <label className="chat-config-toggle">
                  <input type="checkbox" checked={editChatEnabled} onChange={e => setEditChatEnabled(e.target.checked)} />
                  <span>Chat habilitado</span>
                </label>
                <label className="chat-config-toggle">
                  <input type="checkbox" checked={editAnalysisEnabled} onChange={e => setEditAnalysisEnabled(e.target.checked)} />
                  <span>Analisis habilitado</span>
                </label>
              </div>

              {/* Modelo chat */}
              <div className="chat-config-field">
                <label className="chat-config-label">Modelo de chat</label>
                <select className="chat-config-select" value={editChatModel} onChange={e => setEditChatModel(e.target.value)}>
                  {allModels.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                  {/* Si el modelo actual no esta en la lista, mostrarlo igual */}
                  {editChatModel && !allModels.some(m => m.value === editChatModel) && (
                    <option value={editChatModel}>{editChatModel} (no en lista)</option>
                  )}
                </select>
              </div>

              {/* Modelo analisis */}
              <div className="chat-config-field">
                <label className="chat-config-label">Modelo de analisis</label>
                <select className="chat-config-select" value={editAnalysisModel} onChange={e => setEditAnalysisModel(e.target.value)}>
                  {allModels.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                  {editAnalysisModel && !allModels.some(m => m.value === editAnalysisModel) && (
                    <option value={editAnalysisModel}>{editAnalysisModel} (no en lista)</option>
                  )}
                </select>
              </div>

              {/* Temperatura */}
              <div className="chat-config-field">
                <label className="chat-config-label">Temperatura <span className="chat-config-label-value">{editTemperature}</span></label>
                <input type="range" className="chat-config-range" min="0" max="1" step="0.1" value={editTemperature} onChange={e => setEditTemperature(parseFloat(e.target.value))} />
                <div className="chat-config-range-labels">
                  <span>Preciso</span><span>Creativo</span>
                </div>
              </div>

              {/* Nivel de razonamiento */}
              <div className="chat-config-field">
                <label className="chat-config-label">Nivel de razonamiento</label>
                <div className="chat-config-radio-group">
                  {THINKING_LEVELS.map(t => (
                    <label key={t.value} className={`chat-config-radio ${editThinking === t.value ? 'active' : ''}`}>
                      <input type="radio" name="thinking" value={t.value} checked={editThinking === t.value} onChange={e => setEditThinking(e.target.value)} />
                      {t.label}
                    </label>
                  ))}
                </div>
              </div>

              {/* Guardar */}
              <button className="chat-config-save-btn" onClick={handleSaveSettings} disabled={saving}>
                <SaveIcon size={14} /> {saving ? 'Guardando...' : 'Guardar configuracion'}
              </button>
            </div>
          )}

          {/* ─── Pestana: Modelos ─────────────────────────────────── */}
          {settingsTab === 'models' && (
            <div className="chat-config-body">
              <div className="chat-config-section-title">Modelos disponibles</div>
              <div className="chat-models-list">
                {allModels.map((m) => {
                  const isCustom = customModels.some(cm => cm.value === m.value);
                  return (
                    <div key={m.value} className={`chat-model-item ${isCustom ? 'custom' : 'builtin'}`}>
                      <div className="chat-model-item-info">
                        <span className="chat-model-item-name">{m.value}</span>
                        {m.label !== m.value && <span className="chat-model-item-label">{m.label}</span>}
                      </div>
                      <div className="chat-model-item-actions">
                        <span className={`chat-model-badge ${isCustom ? 'custom' : 'builtin'}`}>{isCustom ? 'Personalizado' : 'Base'}</span>
                        {isCustom && (
                          <button className="chat-model-remove-btn" onClick={() => handleRemoveModel(m.value)} title="Eliminar modelo">
                            <XIcon size={12} />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="chat-config-section-title" style={{ marginTop: '16px' }}>Agregar modelo personalizado</div>
              <div className="chat-config-field">
                <label className="chat-config-label">ID del modelo (nombre exacto)</label>
                <input
                  className="chat-config-input"
                  placeholder="ej: gemini-2.5-pro-preview-06-05"
                  value={newModelId}
                  onChange={e => setNewModelId(e.target.value)}
                />
              </div>
              <div className="chat-config-field">
                <label className="chat-config-label">Etiqueta (opcional)</label>
                <input
                  className="chat-config-input"
                  placeholder="ej: Gemini 2.5 Pro"
                  value={newModelLabel}
                  onChange={e => setNewModelLabel(e.target.value)}
                />
              </div>
              <button className="chat-config-action-btn" onClick={handleAddModel} disabled={addingModel || !newModelId.trim()}>
                <PlusIcon size={14} /> {addingModel ? 'Agregando...' : 'Agregar modelo'}
              </button>
              <p className="chat-config-hint" style={{ marginTop: '8px' }}>
                Si seleccionas un modelo que no existe o no soporta tu API Key, el chat respondera con un error.
              </p>
            </div>
          )}

          {/* ─── Pestana: System Prompts ──────────────────────────── */}
          {settingsTab === 'prompts' && (
            <div className="chat-config-body">
              {!promptsData ? (
                <div className="chat-config-actions"><span className="chat-config-hint">Cargando prompts...</span></div>
              ) : (
                <>
                  {/* Selector chat / analisis */}
                  <div className="chat-config-prompt-tabs">
                    <button className={`chat-config-prompt-tab ${promptView === 'chat' ? 'active' : ''}`} onClick={() => setPromptView('chat')}>
                      <BotIcon size={14} /> Chat
                    </button>
                    <button className={`chat-config-prompt-tab ${promptView === 'analysis' ? 'active' : ''}`} onClick={() => setPromptView('analysis')}>
                      <FileTextIcon size={14} /> Analisis
                    </button>
                  </div>

                  {promptView === 'chat' && (
                    <>
                      <div className="chat-config-section-title">System prompt del chat</div>
                      {/* Default prompt (solo lectura) */}
                      <details className="chat-prompt-details">
                        <summary><SparkleIcon size={12} /> Ver prompt por defecto</summary>
                        <pre className="chat-prompt-code">{promptsData.defaultChatPrompt}</pre>
                      </details>

                      {/* Toggle custom override */}
                      <label className="chat-config-toggle" style={{ marginTop: '12px' }}>
                        <input type="checkbox" checked={useCustomChat} onChange={e => setUseCustomChat(e.target.checked)} />
                        <span>Usar prompt personalizado (reemplaza el default)</span>
                      </label>

                      {useCustomChat && (
                        <textarea
                          className="chat-prompt-textarea"
                          value={editChatPrompt}
                          onChange={e => setEditChatPrompt(e.target.value)}
                          placeholder="Escribe tu system prompt personalizado para el chat..."
                          rows={8}
                        />
                      )}
                    </>
                  )}

                  {promptView === 'analysis' && (
                    <>
                      <div className="chat-config-section-title">System prompt del analisis</div>
                      <details className="chat-prompt-details">
                        <summary><SparkleIcon size={12} /> Ver prompt por defecto</summary>
                        <pre className="chat-prompt-code">{promptsData.defaultAnalysisPrompt}</pre>
                      </details>

                      <label className="chat-config-toggle" style={{ marginTop: '12px' }}>
                        <input type="checkbox" checked={useCustomAnalysis} onChange={e => setUseCustomAnalysis(e.target.checked)} />
                        <span>Usar prompt personalizado (reemplaza el default)</span>
                      </label>

                      {useCustomAnalysis && (
                        <textarea
                          className="chat-prompt-textarea"
                          value={editAnalysisPrompt}
                          onChange={e => setEditAnalysisPrompt(e.target.value)}
                          placeholder="Escribe tu system prompt personalizado para el analisis..."
                          rows={8}
                        />
                      )}
                    </>
                  )}

                  <button className="chat-config-save-btn" onClick={handleSavePrompts} disabled={savingPrompts} style={{ marginTop: '12px' }}>
                    <SaveIcon size={14} /> {savingPrompts ? 'Guardando...' : 'Guardar prompts'}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Chat messages area */}
      <div className="chat-messages-container">
        {messages.length === 0 && (
          <div className="chat-empty-state">
            <div className="chat-empty-icon-wrap"><BotIcon size={40} /></div>
            <h3>Asistente de AdminLank</h3>
            <p>Pregunta sobre el estado de las suscripciones, alertas pendientes, o pide que haga cambios en el sistema.</p>
            <div className="chat-suggestions">
              {[
                'Cuantas alertas pendientes hay?',
                'Cual es el estado de ChatGPT Plus?',
                'Resumeme el ultimo analisis',
                'Hay cuentas con error de acceso?',
              ].map((suggestion, i) => (
                <button key={i} className="chat-suggestion-btn" onClick={() => { setInput(suggestion); inputRef.current?.focus(); }}>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`chat-message ${msg.role === 'user' ? 'user' : 'assistant'} ${msg.error ? 'error' : ''}`}>
            <div className="chat-message-avatar">
              {msg.role === 'user' ? 'D' : <BotIcon size={16} />}
            </div>
            <div className="chat-message-bubble">
              {/* Thinking section (cadena de razonamiento) */}
              {msg.thinking && (
                <div className="chat-thinking-section">
                  <button className="chat-thinking-toggle" onClick={() => toggleThinking(i)}>
                    <BrainIcon size={13} />
                    <span>Cadena de razonamiento</span>
                    <ChevronIcon size={11} open={expandedThinking[i]} />
                  </button>
                  {expandedThinking[i] && (
                    <pre className="chat-thinking-content">{msg.thinking}</pre>
                  )}
                </div>
              )}

              <div className="chat-message-content" dangerouslySetInnerHTML={{ __html: formatMessageText(msg.content) }} />
              <div className="chat-message-time">
                {msg.source === 'telegram' && <TelegramIcon size={11} />}
                {formatTime(msg.timestamp)}
              </div>
            </div>
          </div>
        ))}

        {loading && (
          <div className="chat-message assistant">
            <div className="chat-message-avatar"><BotIcon size={16} /></div>
            <div className="chat-message-bubble">
              <div className="chat-typing-indicator"><span /><span /><span /></div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="chat-input-area">
        {!isEnabled && (
          <div className="chat-disabled-banner">
            <AlertTriangleIcon size={14} />
            <span>El chat con IA esta deshabilitado. Abre Configuracion arriba para configurar la API Key y habilitar el chat.</span>
          </div>
        )}
        <div className="chat-input-wrapper">
          <textarea
            ref={(el) => { textareaRef.current = el; inputRef.current = el; }}
            className="chat-input"
            placeholder={isEnabled ? 'Escribe un mensaje...' : 'Chat deshabilitado'}
            value={input}
            onChange={handleTextareaInput}
            onKeyDown={handleKeyDown}
            disabled={!isEnabled || loading}
            rows={1}
          />
          <button className="chat-send-btn" onClick={handleSend} disabled={!input.trim() || loading || !isEnabled}>
            <SendIcon size={18} />
          </button>
        </div>
        <div className="chat-input-hint">Enter para enviar · Shift+Enter para nueva linea</div>
      </div>
    </div>
  );
}
