const togglePassword = document.getElementById('togglePassword');
const passwordInput = document.getElementById('passwordInput');
const eyeOpen = document.getElementById('eyeOpen');
const eyeClosed = document.getElementById('eyeClosed');

togglePassword.addEventListener('click', () => {
    const type = passwordInput.getAttribute('type') === 'password' ? 'text' : 'password';
    passwordInput.setAttribute('type', type);
    eyeOpen.classList.toggle('hidden');
    eyeClosed.classList.toggle('hidden');
});