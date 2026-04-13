const togglePassword = document.getElementById('togglePassword');
const passwordInput = document.getElementById('passwordInput');
const eyeOpen = document.getElementById('eyeOpen');
const eyeClosed = document.getElementById('eyeClosed');
const loginForm = document.getElementById('loginForm');
const rememberMe = document.getElementById('rememberMe');
const idInput = document.querySelector('input[name="id_number"]');
const forgotLink = document.getElementById('forgotPasswordLink');
const forgotModal = document.getElementById('forgotModal');
const forgotSubmitBtn = document.getElementById('forgotSubmitBtn');

togglePassword.addEventListener('click', () => {
    const type = passwordInput.getAttribute('type') === 'password' ? 'text' : 'password';
    passwordInput.setAttribute('type', type);
    eyeOpen.classList.toggle('hidden');
    eyeClosed.classList.toggle('hidden');
});

window.addEventListener('DOMContentLoaded', () => {
    const saved = localStorage.getItem('rememberedId');
    if (saved && idInput) {
        idInput.value = saved;
        if (rememberMe) rememberMe.checked = true;
    }
});

if (loginForm) {
    loginForm.addEventListener('submit', () => {
        const submitBtn = document.getElementById('loginSubmitBtn');
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.style.opacity = '0.7';
            submitBtn.textContent = 'Logging in...';
        }

        if (rememberMe && idInput) {
            if (rememberMe.checked) localStorage.setItem('rememberedId', idInput.value.trim());
            else localStorage.removeItem('rememberedId');
        }
    });
}

if (forgotLink && forgotModal) {
    forgotLink.addEventListener('click', (e) => {
        e.preventDefault();
        forgotModal.classList.remove('hidden');
        forgotModal.classList.add('flex');
    });
}

window.closeForgotModal = function () {
    if (!forgotModal) return;
    forgotModal.classList.add('hidden');
    forgotModal.classList.remove('flex');
};

if (forgotSubmitBtn) {
    forgotSubmitBtn.addEventListener('click', async () => {
        const idField = document.querySelector('[name="forgotId"]');
        const emailField = document.querySelector('[name="forgotEmail"]');
        const messageBox = document.getElementById('forgotMessage');
        const id = idField ? idField.value.trim() : '';
        const email = emailField ? emailField.value.trim() : '';

        if (!id || !email) {
            if (messageBox) {
                messageBox.className = 'text-sm rounded-lg p-2 bg-red-50 text-red-700 border border-red-200';
                messageBox.textContent = 'Please fill in all fields.';
            }
            return;
        }

        forgotSubmitBtn.disabled = true;
        forgotSubmitBtn.style.opacity = '0.7';
        forgotSubmitBtn.textContent = 'Please wait...';

        try {
            const response = await fetch('/forgot-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `forgotId=${encodeURIComponent(id)}&forgotEmail=${encodeURIComponent(email)}`
            });
            const data = await response.json();
            if (messageBox) {
                const ok = !!data.success;
                messageBox.className = `text-sm rounded-lg p-2 border ${ok ? 'bg-green-50 text-green-700 border-green-200' : 'bg-red-50 text-red-700 border-red-200'}`;
                messageBox.textContent = data.message || (ok ? 'Request submitted.' : 'Request failed.');
            }
        } catch (err) {
            if (messageBox) {
                messageBox.className = 'text-sm rounded-lg p-2 bg-green-50 text-green-700 border border-green-200';
                messageBox.textContent = 'If your ID and email match, a reset link has been sent.';
            }
        } finally {
            forgotSubmitBtn.disabled = false;
            forgotSubmitBtn.style.opacity = '1';
            forgotSubmitBtn.textContent = 'Send Reset Link';
        }
    });
}