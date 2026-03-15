function validate(condition, element) {
    if (condition) {
        element.classList.remove('text-blue-700');
        element.classList.add('text-green-600', 'font-bold');
    } else {
        element.classList.remove('text-green-600', 'font-bold');
        element.classList.add('text-blue-700');
    }
}

function setupPasswordToggle(buttonId, inputId, eyeOpenId, eyeClosedId) {
    const toggleBtn = document.getElementById(buttonId);
    const inputField = document.getElementById(inputId);
    const openIcon = document.getElementById(eyeOpenId);
    const closedIcon = document.getElementById(eyeClosedId);

    toggleBtn.addEventListener('click', () => {
        const isPassword = inputField.getAttribute('type') === 'password';
        inputField.setAttribute('type', isPassword ? 'text' : 'password');
        openIcon.classList.toggle('hidden');
        closedIcon.classList.toggle('hidden');
    });
}

const passInput = document.getElementById('passwordInput');
const confirmInput = document.getElementById('confirmPasswordInput');

const reqLength = document.getElementById('req-length');
const reqUpper = document.getElementById('req-upper');
const reqLower = document.getElementById('req-lower');
const reqNumber = document.getElementById('req-number');
const reqMatch = document.getElementById('req-match');

function checkPasswords() {
    const val = passInput.value;
    const confirmVal = confirmInput.value;

    validate(val.length >= 8, reqLength);
    validate(/[A-Z]/.test(val), reqUpper);
    validate(/[a-z]/.test(val), reqLower);
    validate(/[0-9]/.test(val), reqNumber);

    const isMatching = (val === confirmVal && val.length > 0);
    validate(isMatching, reqMatch);
}

passInput.addEventListener('input', checkPasswords);
confirmInput.addEventListener('input', checkPasswords);

setupPasswordToggle('togglePassword', 'passwordInput', 'eyeOpen1', 'eyeClosed1');
setupPasswordToggle('toggleConfirmPassword', 'confirmPasswordInput', 'eyeOpen2', 'eyeClosed2');