export type StoredProfile = {
  name: string;
  avatar: string;
  status: string;
};

type ScreenLinkProfileBridge = {
  load: () => Promise<StoredProfile | null>;
  save: (profile: StoredProfile) => Promise<void>;
};

declare global {
  interface Window {
    screenLinkProfile?: ScreenLinkProfileBridge;
  }
}

const DATABASE_NAME = 'screenlink-local';
const STORE_NAME = 'profile';
const PROFILE_ID = 'current';
const MAX_SHARED_AVATAR_LENGTH = 32_000;

function openProfileDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Não foi possível abrir o perfil local.'));
  });
}

async function readBrowserProfile() {
  const database = await openProfileDatabase();
  try {
    return await new Promise<StoredProfile | null>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(PROFILE_ID);
      request.onsuccess = () => resolve((request.result as StoredProfile | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error('Não foi possível ler o perfil local.'));
    });
  } finally {
    database.close();
  }
}

async function writeBrowserProfile(profile: StoredProfile) {
  const database = await openProfileDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(profile, PROFILE_ID);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Não foi possível salvar o perfil local.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('O salvamento do perfil foi cancelado.'));
    });
  } finally {
    database.close();
  }
}

export function profileStorageKind() {
  return window.screenLinkProfile ? 'sqlite' : 'browser';
}

export async function loadStoredProfile() {
  return window.screenLinkProfile ? window.screenLinkProfile.load() : readBrowserProfile();
}

export async function saveStoredProfile(profile: StoredProfile) {
  if (window.screenLinkProfile) await window.screenLinkProfile.save(profile);
  else await writeBrowserProfile(profile);
}

function canvasDataUrl(image: ImageBitmap, size: number, quality: number) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas indisponível.');

  const crop = Math.min(image.width, image.height);
  const sourceX = (image.width - crop) / 2;
  const sourceY = (image.height - crop) / 2;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, sourceX, sourceY, crop, crop, 0, 0, size, size);
  return canvas.toDataURL('image/webp', quality);
}

export async function prepareAvatar(file: File) {
  if (!file.type.startsWith('image/') || file.size > 12 * 1024 * 1024) {
    throw new Error('Escolha uma imagem de até 12 MB.');
  }

  const image = await createImageBitmap(file);
  try {
    for (const [size, quality] of [[160, .82], [144, .76], [128, .7], [112, .64]] as const) {
      const dataUrl = canvasDataUrl(image, size, quality);
      if (dataUrl.length <= MAX_SHARED_AVATAR_LENGTH) return dataUrl;
    }
  } finally {
    image.close();
  }
  throw new Error('Não foi possível reduzir essa imagem para o perfil.');
}
