// Content-agnostic program model. No behavioral interpretation lives here.

function validateSet(set) {
  if (!set || !set.id || !set.programVersion) throw new TypeError('set.id and set.programVersion are required');
  if (!Array.isArray(set.probes) || set.probes.length === 0) throw new TypeError('set.probes must be non-empty');
  return set;
}

function getProbe(set, index) {
  validateSet(set);
  return set.probes[index] || null;
}

module.exports = { validateSet, getProbe };
