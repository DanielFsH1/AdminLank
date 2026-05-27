function compact(value) {
  return String(value || '').trim();
}

function normalizeFieldKey(key) {
  if (key === 'memberPhone' || key === 'whatsapp') return 'phone';
  if (key === 'email' || key === 'invitationEmail') return 'userEmail';
  if (key === 'memberEmail') return 'userEmail';
  return key;
}

function fieldValue(user = {}, linkedSlot = {}, key) {
  const normalized = normalizeFieldKey(key);

  if (normalized === 'phone') {
    return compact(user.phone || user.memberPhone || user.whatsapp);
  }

  if (normalized === 'userEmail') {
    return compact(
      user.userEmail
      || user.email
      || user.invitationEmail
      || linkedSlot.memberEmail
      || linkedSlot.email,
    );
  }

  if (normalized === 'profileName') {
    return compact(user.profileName || linkedSlot.profileName);
  }

  if (normalized === 'projectName') {
    const project = user.projectName;
    if (Array.isArray(project)) return project.length > 0 ? project.join(', ') : '';
    return compact(project || linkedSlot.projectName);
  }

  return compact(user[normalized] || linkedSlot[normalized]);
}

function labelForField(field, key) {
  if (field?.label) return field.label;
  const labels = {
    userAlias: 'Alias del usuario',
    phone: 'Teléfono',
    userEmail: 'Correo de invitación',
    profileName: 'Perfil',
    projectName: 'Proyecto',
  };
  return labels[normalizeFieldKey(key)] || key;
}

export function getRequiredUserDataFields(userFields = []) {
  const required = new Map();

  required.set('userAlias', { key: 'userAlias', label: 'Alias del usuario' });
  required.set('phone', { key: 'phone', label: 'Teléfono' });

  userFields.forEach((field) => {
    if (!field?.key || field.key === 'userAlias') return;
    const normalizedKey = normalizeFieldKey(field.key);
    if (field.required || ['phone', 'userEmail', 'profileName', 'projectName'].includes(normalizedKey)) {
      required.set(normalizedKey, { ...field, key: normalizedKey, label: labelForField(field, normalizedKey) });
    }
  });

  return [...required.values()];
}

export function getMissingUserDataFields({ user, userFields = [], linkedSlot = null } = {}) {
  if (!user) return [];
  const normalizedUser = typeof user === 'string' ? { userAlias: user } : user;
  const slot = linkedSlot || {};

  return getRequiredUserDataFields(userFields)
    .filter(field => !fieldValue(normalizedUser, slot, field.key))
    .map(field => labelForField(field, field.key));
}

export function hasMissingUserData(input = {}) {
  return getMissingUserDataFields(input).length > 0;
}
