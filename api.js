import { getApiKeys } from './storage.js';

/**
 * 1. Mengirim file audio/video ke Groq Whisper API untuk transkripsi dengan timestamp
 */
export async function transcribeMedia(file, sourceLang = 'auto') {
  const { groq } = getApiKeys();
  if (!groq) throw new Error('Groq API Key belum diisi di Pengaturan.');

  // Validasi batas ukuran file Whisper API (25 MB)
  const maxSize = 25 * 1024 * 1024;
  if (file.size > maxSize) {
    throw new Error('Ukuran file melebihi 25 MB. Kompres audio menjadi MP3 terlebih dahulu.');
  }

  const formData = new FormData();
  formData.append('file', file);
  formData.append('model', 'whisper-large-v3-turbo');
  formData.append('response_format', 'verbose_json');
  
  if (sourceLang !== 'auto') {
    formData.append('language', sourceLang);
  }

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${groq}`
    },
    body: formData
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error?.message || `Gagal transkripsi (HTTP ${response.status})`);
  }

  const data = await response.json();
  
  // Normalisasi segmen agar selalu memiliki start, end, dan text
  const segments = (data.segments || []).map((seg, index) => ({
    id: index,
    start: seg.start,
    end: seg.end,
    originalText: seg.text.trim(),
    translatedText: ''
  }));

  return {
    detectedLanguage: data.language || sourceLang,
    segments
  };
}

/**
 * 2. Menerjemahkan segmen transkrip & membuat ringkasan belajar via Gemini API
 */
export async function translateAndSummarize(segments, targetLanguage) {
  const { gemini } = getApiKeys();
  if (!gemini) throw new Error('Gemini API Key belum diisi di Pengaturan.');

  // Siapkan array teks ringkas untuk dikirim ke Gemini
  const payloadLines = segments.map(s => `[${s.id}] ${s.originalText}`).join('\n');

  const prompt = `
Anda adalah asisten penerjemah akademik profesional untuk pelajar.
Tugas Anda:
1. Terjemahkan setiap baris transkrip berikut ke dalam bahasa ${targetLanguage} secara natural, akurat, dan mudah dipahami dalam konteks pembelajaran. Pertahankan nomor indeks [id].
2. Buat ringkasan poin-poin pembelajaran utama (Study Notes) dan daftar kosakata/istilah penting dari transkrip tersebut dalam bahasa ${targetLanguage}.

Kembalikan respons HANYA dalam format JSON valid berikut tanpa markdown tambahan:
{
  "translations": [
    { "id": 0, "text": "hasil terjemahan baris 0" }
  ],
  "summary": "Teks ringkasan poin belajar dan glosarium istilah penting..."
}

Transkrip Asli:
${payloadLines}
`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${gemini}`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2
      }
    })
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error?.message || `Gagal menerjemahkan (HTTP ${response.status})`);
  }

  const result = await response.json();
  const rawJsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;
  
  if (!rawJsonText) throw new Error('Respons AI kosong.');

  const parsed = JSON.parse(rawJsonText);

  // Gabungkan hasil terjemahan ke masing-masing segmen berdasarkan ID
  const translationMap = new Map(
    (parsed.translations || []).map(item => [item.id, item.text])
  );

  const enrichedSegments = segments.map(seg => ({
    ...seg,
    translatedText: translationMap.get(seg.id) || '(Terjemahan tidak tersedia)'
  }));

  return {
    segments: enrichedSegments,
    summary: parsed.summary || 'Ringkasan tidak tersedia.'
  };
}
