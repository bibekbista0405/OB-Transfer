const request = (url, options = {}) => fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: options.body instanceof FormData
        ? options.headers
        : { ...(options.headers || {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}) }
});

export const api = {
    session: () => request('/api/auth/session'),
    login: (password) => request('/api/auth', {
        method: 'POST',
        body: JSON.stringify({ password })
    }),
    files: () => request('/api/files'),
    deleteFile: (id) => request(`/api/files/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    upload: (formData, signal) => request('/api/upload', {
        method: 'POST',
        body: formData,
        signal
    })
};
