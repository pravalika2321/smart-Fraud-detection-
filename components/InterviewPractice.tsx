
import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { PracticeTranscription } from '../types';

const FRAME_RATE = 1; // 1 frame per second for video analysis
const JPEG_QUALITY = 0.6;

// Utility functions for audio encoding/decoding as per Gemini SDK requirements
function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function encode(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

const InterviewPractice: React.FC = () => {
  const [isActive, setIsActive] = useState(false);
  const [role, setRole] = useState('Software Engineer');
  const [experience, setExperience] = useState('Entry Level');
  const [transcriptions, setTranscriptions] = useState<PracticeTranscription[]>([]);
  const [isConnecting, setIsConnecting] = useState(false);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const frameIntervalRef = useRef<number | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [transcriptions]);

  const stopSession = () => {
    setIsActive(false);
    setIsConnecting(false);
    if (sessionRef.current) sessionRef.current.close();
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    if (frameIntervalRef.current) clearInterval(frameIntervalRef.current);
    if (audioContextInRef.current) audioContextInRef.current.close();
    if (audioContextOutRef.current) audioContextOutRef.current.close();
    sessionRef.current = null;
  };

  const startSession = async () => {
    setIsConnecting(true);
    setTranscriptions([{ text: "Connecting to AI Interviewer...", role: 'assistant', timestamp: Date.now() }]);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;

      const audioCtxIn = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const audioCtxOut = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      audioContextInRef.current = audioCtxIn;
      audioContextOutRef.current = audioCtxOut;

      let currentOutText = "";
      let currentInText = "";

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: `You are a Senior Technical Recruiter. Conduct a realistic job interview for a ${experience} ${role} position. 
          Be professional, probing, and supportive. Start by introducing yourself and asking the first question. 
          Watch the user's video feed for professional presence and non-verbal cues.`,
        },
        callbacks: {
          onopen: () => {
            setIsActive(true);
            setIsConnecting(false);
            
            // Handle Audio Input
            const source = audioCtxIn.createMediaStreamSource(stream);
            const scriptProcessor = audioCtxIn.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const l = inputData.length;
              const int16 = new Int16Array(l);
              for (let i = 0; i < l; i++) int16[i] = inputData[i] * 32768;
              const pcmBlob = {
                data: encode(new Uint8Array(int16.buffer)),
                mimeType: 'audio/pcm;rate=16000',
              };
              sessionPromise.then(session => session.sendRealtimeInput({ media: pcmBlob }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioCtxIn.destination);

            // Handle Video Input
            frameIntervalRef.current = window.setInterval(() => {
              if (canvasRef.current && videoRef.current) {
                const ctx = canvasRef.current.getContext('2d');
                canvasRef.current.width = 320;
                canvasRef.current.height = 240;
                ctx?.drawImage(videoRef.current, 0, 0, 320, 240);
                canvasRef.current.toBlob(async (blob) => {
                  if (blob) {
                    const reader = new FileReader();
                    reader.onloadend = () => {
                      const base64 = (reader.result as string).split(',')[1];
                      sessionPromise.then(session => session.sendRealtimeInput({ media: { data: base64, mimeType: 'image/jpeg' } }));
                    };
                    reader.readAsDataURL(blob);
                  }
                }, 'image/jpeg', JPEG_QUALITY);
              }
            }, 1000 / FRAME_RATE);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Transcription logic
            if (message.serverContent?.outputTranscription) {
              currentOutText += message.serverContent.outputTranscription.text;
            } else if (message.serverContent?.inputTranscription) {
              currentInText += message.serverContent.inputTranscription.text;
            }

            if (message.serverContent?.turnComplete) {
              if (currentInText) setTranscriptions(prev => [...prev, { role: 'user', text: currentInText, timestamp: Date.now() }]);
              if (currentOutText) setTranscriptions(prev => [...prev, { role: 'assistant', text: currentOutText, timestamp: Date.now() }]);
              currentInText = "";
              currentOutText = "";
            }

            // Audio Playback
            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData) {
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, audioCtxOut.currentTime);
              const buffer = await decodeAudioData(decode(audioData), audioCtxOut, 24000, 1);
              const source = audioCtxOut.createBufferSource();
              source.buffer = buffer;
              source.connect(audioCtxOut.destination);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
            }

            if (message.serverContent?.interrupted) {
              nextStartTimeRef.current = 0;
            }
          },
          onclose: () => stopSession(),
          onerror: (e) => {
             console.error("Live session error", e);
             stopSession();
          }
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err) {
      console.error(err);
      stopSession();
      alert("Microphone and Camera permissions are required for the AI Practice session.");
    }
  };

  return (
    <div className="min-h-[calc(100vh-64px)] bg-slate-950 text-slate-100 flex flex-col items-center p-4 md:p-8 animate-in fade-in duration-500">
      <div className="max-w-7xl w-full flex flex-col lg:flex-row gap-8 flex-grow">
        
        {/* Left Side: Video & Controls */}
        <div className="lg:w-1/2 flex flex-col space-y-6">
          <div className="relative aspect-video bg-slate-900 rounded-[2.5rem] overflow-hidden shadow-2xl border-4 border-slate-800 flex items-center justify-center">
            <video ref={videoRef} autoPlay muted playsInline className="w-full h-full object-cover scale-x-[-1]" />
            <canvas ref={canvasRef} className="hidden" />
            
            {!isActive && !isConnecting && (
              <div className="absolute inset-0 bg-slate-900/80 backdrop-blur-sm flex flex-col items-center justify-center p-8 text-center">
                <div className="w-20 h-20 bg-blue-600 rounded-3xl flex items-center justify-center mb-6 shadow-lg shadow-blue-500/20">
                  <i className="fas fa-video text-3xl"></i>
                </div>
                <h2 className="text-3xl font-black mb-4">Interview Practice Studio</h2>
                <p className="text-slate-400 max-w-sm mb-8">
                  Get real-time feedback on your technical skills, professional presence, and verbal communication.
                </p>
                <div className="flex flex-wrap justify-center gap-4 mb-8">
                   <select value={role} onChange={e => setRole(e.target.value)} className="bg-slate-800 border border-slate-700 px-4 py-3 rounded-xl outline-none focus:ring-2 focus:ring-blue-500 font-bold text-sm">
                      <option>Software Engineer</option>
                      <option>Product Manager</option>
                      <option>UX Designer</option>
                      <option>Data Scientist</option>
                   </select>
                   <select value={experience} onChange={e => setExperience(e.target.value)} className="bg-slate-800 border border-slate-700 px-4 py-3 rounded-xl outline-none focus:ring-2 focus:ring-blue-500 font-bold text-sm">
                      <option>Entry Level</option>
                      <option>Mid-Level</option>
                      <option>Senior</option>
                   </select>
                </div>
                <button onClick={startSession} className="px-10 py-4 bg-blue-600 hover:bg-blue-500 text-white rounded-2xl font-black shadow-xl shadow-blue-900/20 transition-all active:scale-95 flex items-center uppercase tracking-widest text-sm">
                  <i className="fas fa-play mr-3"></i> Start Live Session
                </button>
              </div>
            )}

            {isConnecting && (
              <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-md flex flex-col items-center justify-center">
                 <div className="w-16 h-16 border-4 border-blue-500/30 border-t-blue-500 rounded-full animate-spin mb-4"></div>
                 <div className="text-blue-400 font-black uppercase tracking-widest text-xs">Initializing AI Recruiter...</div>
              </div>
            )}

            {isActive && (
              <div className="absolute top-6 left-6 flex items-center space-x-2">
                 <div className="w-2.5 h-2.5 bg-red-600 rounded-full animate-pulse shadow-[0_0_10px_rgba(220,38,38,0.8)]"></div>
                 <span className="text-[10px] font-black uppercase tracking-widest bg-slate-900/60 px-2 py-1 rounded backdrop-blur-md">Live Session</span>
              </div>
            )}
          </div>

          <div className="flex justify-between items-center p-6 bg-slate-900 rounded-3xl border border-slate-800">
             <div className="flex items-center space-x-4">
                <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${isActive ? 'bg-green-600/10 text-green-500' : 'bg-slate-800 text-slate-500'}`}>
                  <i className={`fas ${isActive ? 'fa-microphone' : 'fa-microphone-slash'}`}></i>
                </div>
                <div>
                   <div className="text-[10px] font-black uppercase tracking-widest text-slate-500">Audio Stream</div>
                   <div className="text-sm font-bold">{isActive ? 'Mic Active' : 'Waiting...'}</div>
                </div>
             </div>
             
             {isActive && (
               <button onClick={stopSession} className="px-6 py-3 bg-red-600/20 hover:bg-red-600 text-red-600 hover:text-white rounded-xl text-xs font-black uppercase tracking-widest transition-all">
                 <i className="fas fa-stop mr-2"></i> End Session
               </button>
             )}
          </div>
        </div>

        {/* Right Side: Transcription & Waveform */}
        <div className="lg:w-1/2 flex flex-col bg-slate-900 rounded-[2.5rem] shadow-2xl border border-slate-800 overflow-hidden min-h-[500px]">
           <div className="p-8 border-b border-slate-800 flex justify-between items-center">
              <h3 className="text-xl font-black flex items-center">
                <i className="fas fa-comment-dots mr-3 text-blue-500"></i> Interview Logs
              </h3>
              <div className="flex space-x-1">
                 {[1, 2, 3].map(i => <div key={i} className={`w-1 h-3 bg-blue-500 rounded-full ${isActive ? 'animate-bounce' : ''}`} style={{animationDelay: `${i*0.2}s`}}></div>)}
              </div>
           </div>
           
           <div ref={transcriptRef} className="flex-grow p-8 overflow-y-auto space-y-6 scrollbar-hide">
              {transcriptions.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center opacity-30 text-center">
                   <i className="fas fa-wave-square text-4xl mb-4"></i>
                   <p className="text-sm font-bold italic">Transcript will appear here in real-time...</p>
                </div>
              )}
              {transcriptions.map((t, i) => (
                <div key={i} className={`flex ${t.role === 'user' ? 'justify-end' : 'justify-start'} animate-in slide-in-from-bottom-2`}>
                   <div className={`max-w-[85%] p-4 rounded-2xl text-sm leading-relaxed ${
                     t.role === 'user' ? 'bg-blue-600 text-white rounded-br-none' : 'bg-slate-800 text-slate-300 rounded-tl-none border border-slate-700'
                   }`}>
                      {t.text}
                   </div>
                </div>
              ))}
           </div>

           {isActive && (
             <div className="p-8 bg-slate-800/30 border-t border-slate-800 flex flex-col items-center justify-center space-y-4">
                <div className="flex items-center space-x-1 h-12">
                   {Array.from({ length: 24 }).map((_, i) => (
                     <div 
                        key={i} 
                        className="w-1 bg-blue-500 rounded-full transition-all duration-100" 
                        style={{ height: `${Math.random() * 100}%` }}
                      ></div>
                   ))}
                </div>
                <div className="text-[10px] font-black uppercase tracking-[0.2em] text-blue-400">Listening to your response</div>
             </div>
           )}
        </div>
      </div>
    </div>
  );
};

export default InterviewPractice;
