const { assign } = require('xstate');
const dialog = require('../util/dialog');

const REPLY_TYPES = ['text', 'button'];

function resolve(value, context, event) {
  if (typeof value === 'function') return value(context, event);
  if (value && typeof value === 'object') return dialog.get_message(value, context.user.locale);
  return value;
}

function render(bundle, fill, context, event) {
  let text = dialog.get_message(bundle, context.user.locale);
  for (const token of Object.keys(fill || {})) {
    const marker = `{{${token}}}`;
    if (!text.includes(marker)) continue;
    text = text.split(marker).join(String(resolve(fill[token], context, event) ?? ''));
  }
  return text;
}

function emit(context, text, immediate = true, delay = 0) {
  if (!delay) return dialog.sendMessage(context, text, immediate);
  setTimeout(() => dialog.sendMessage(context, text, immediate), delay);
}

function node(step, states) {
  return { ...(step.id ? { id: step.id } : {}), initial: 'question', states };
}

function promptList(step) {
  if (Array.isArray(step.prompt)) return step.prompt;
  return [{ bundle: step.prompt, delay: step.delay }];
}

function sendPrompts(step, context, event) {
  for (const item of promptList(step)) {
    emit(context, render(item.bundle, step.fill, context, event), item.immediate !== false, item.delay || 0);
  }
}

function questionState(step, prepare) {
  return {
    onEntry: assign((context, event) => {
      if (prepare) prepare(context);
      sendPrompts(step, context, event);
    }),
    on: { USER_MESSAGE: 'process' }
  };
}

function errorState(step, pick) {
  return {
    onEntry: assign((context) => {
      const bundle = pick(context) || step.retry || dialog.global_messages.error.retry;
      emit(context, render(bundle, step.fill, context), false);
    }),
    always: 'question'
  };
}

function branch(value) {
  return typeof value === 'string' ? { to: value } : value;
}

function writesOf(spec, stepWrite) {
  const writes = [];
  if (stepWrite) writes.push(stepWrite);
  if (spec.set) writes.push(spec.set);
  if (!writes.length) return {};
  return {
    actions: assign((context, event) => {
      for (const write of writes) write(context, event);
    })
  };
}

function transitions(next, stepWrite) {
  const list = Array.isArray(next) ? next : [next];
  return list.map((entry) => {
    const spec = branch(entry);
    return {
      target: spec.to,
      ...(spec.when ? { cond: spec.when } : {}),
      ...writesOf(spec, stepWrite)
    };
  });
}

function choiceGrammer(step) {
  return step.options.map((option, index) => ({
    intention: option,
    recognize: [String(index + 1), String(option).toLowerCase()]
  }));
}

function readChoice(step, grammerOf) {
  return assign((context, event) => {
    const grammer = grammerOf(context);
    if (!grammer || !dialog.validateInputType(event, step.accept || REPLY_TYPES)) {
      context.intention = dialog.INTENTION_UNKOWN;
      return;
    }
    context.intention = dialog.get_intention(grammer, event, true);
  });
}

function choiceWrite(step) {
  if (!step.slot && !step.set) return null;
  return (context) => {
    const value = step.value ? step.value(context.intention) : context.intention;
    if (step.slot) context.slots.pgr[step.slot] = value;
    if (step.set) step.set(context, value);
  };
}

function assertOptionsRouted(step) {
  const missing = step.options.filter((option) => !(option in step.next));
  if (missing.length) {
    throw new Error(`flow: step '${step.key}' offers option(s) ${missing.join(', ')} with no next target`);
  }
}

function choiceTransitions(step) {
  const write = choiceWrite(step);
  const branches = Object.keys(step.next).map((intention) => {
    const spec = branch(step.next[intention]);
    return {
      target: spec.to,
      cond: (context) => context.intention === intention,
      ...writesOf(spec, write)
    };
  });
  return branches.concat([{ target: 'error' }]);
}

function readInput(step) {
  const media = Array.isArray(step.accept);
  return assign((context, event) => {
    if (!dialog.validateInputType(event, step.accept)) {
      context.message = { isValid: !!(step.optional && String(event.message?.input ?? '') === '1') };
      return;
    }
    const input = media ? event.message.input : String(event.message.input).trim();
    const verdict = step.validate ? step.validate(input) : true;
    context.message = { isValid: verdict === true, retry: verdict === true ? undefined : verdict || undefined };
    if (context.message.isValid) {
      if (step.slot) context.slots.pgr[step.slot] = input;
      if (step.set) step.set(context, input);
    }
  });
}

function withTrail(preamble, path, trailBundle, context) {
  const trail = path
    .map((code) => (trailBundle && trailBundle[code] ? dialog.get_message(trailBundle[code], context.user.locale) : code))
    .join(' › ');
  return trail ? `*${trail}*\n${preamble}` : preamble;
}

function walkQuestion(step) {
  return {
    onEntry: assign((context) => {
      const { options, messageBundle, trailBundle, levelLabel } = context[step.stepSlot];
      const path = context.slots.pgr[step.pathSlot] || [];
      let preamble = render(step.preamble, { level: levelLabel }, context);
      if (step.trail) preamble = withTrail(preamble, path, trailBundle, context);
      const list = dialog.constructListPromptAndGrammer(options, messageBundle, context.user.locale, false, path.length > 0);
      context.grammer = list.grammer;
      emit(context, `${preamble}${list.prompt}`);
    }),
    on: { USER_MESSAGE: 'process' }
  };
}

function fetchState(step) {
  return {
    invoke: {
      id: step.invokeId || `fetch_${step.key}`,
      src: (context) => step.fetch(context, context.slots.pgr[step.pathSlot] || []),
      onDone: {
        target: 'evaluate',
        actions: assign((context, event) => {
          context[step.stepSlot] = event.data;
        })
      },
      onError: { target: step.onError || '#system_error' }
    }
  };
}

function evaluateState(step) {
  const empty = step.onEmpty;
  const escape = empty
    ? [{
        target: empty.to,
        cond: (context) => (context[step.stepSlot].options || []).length === 0,
        actions: assign((context) => {
          const path = context.slots.pgr[step.pathSlot] || [];
          context.slots.pgr[empty.slot] = path[path.length - 1];
          if (empty.set) empty.set(context);
        })
      }]
    : [];
  return { always: escape.concat([{ target: 'question' }]) };
}

function pushPath(step, context, code) {
  context.slots.pgr[step.pathSlot] = [...(context.slots.pgr[step.pathSlot] || []), code];
}

function walkTransitions(step) {
  return [
    {
      target: 'fetch',
      cond: (context) => !context[step.stepSlot]
    },
    {
      target: 'fetch',
      cond: (context) => context.intention === dialog.INTENTION_GOBACK,
      actions: assign((context) => {
        context.slots.pgr[step.pathSlot] = (context.slots.pgr[step.pathSlot] || []).slice(0, -1);
      })
    },
    {
      target: step.onLeaf.to,
      cond: (context) => context.intention !== dialog.INTENTION_UNKOWN && context[step.stepSlot].isLeafLevel,
      actions: assign((context) => {
        pushPath(step, context, context.intention);
        context.slots.pgr[step.onLeaf.slot] = context.intention;
        if (step.onLeaf.set) step.onLeaf.set(context);
      })
    },
    {
      target: 'fetch',
      cond: (context) => context.intention !== dialog.INTENTION_UNKOWN,
      actions: assign((context) => {
        pushPath(step, context, context.intention);
      })
    },
    { target: 'error' }
  ];
}

function callMessage(branch, context, event) {
  return typeof branch.message === 'function'
    ? branch.message(context, event)
    : render(branch.message, branch.fill, context, event);
}

const emitters = {
  say: (step) => ({
    ...(step.id ? { id: step.id } : {}),
    onEntry: assign((context, event) => {
      sendPrompts(step, context, event);
    }),
    always: transitions(step.next)
  }),

  ask: (step) => node(step, {
    question: questionState(step),
    process: {
      onEntry: readInput(step),
      always: transitions(step.next)
        .map((transition) => ({
          ...transition,
          cond: transition.cond
            ? (context, event) => context.message.isValid && transition.cond(context, event)
            : (context) => context.message.isValid
        }))
        .concat([{ target: 'error' }])
    },
    error: errorState(step, (context) => context.message && context.message.retry)
  }),

  choose: (step) => {
    assertOptionsRouted(step);
    const grammer = choiceGrammer(step);
    return node(step, {
      question: questionState(step),
      process: { onEntry: readChoice(step, () => grammer), always: choiceTransitions(step) },
      error: errorState(step, () => undefined)
    });
  },

  walk: (step) => ({
    ...(step.id ? { id: step.id } : {}),
    initial: 'fetch',
    states: {
      fetch: fetchState(step),
      evaluate: evaluateState(step),
      question: walkQuestion(step),
      process: { onEntry: readChoice(step, (context) => context.grammer), always: walkTransitions(step) },
      error: errorState(step, () => undefined)
    }
  }),

  call: (step) => ({
    ...(step.id ? { id: step.id } : {}),
    invoke: {
      id: step.invokeId || step.key,
      src: (context, event) => step.src(context, event),
      onDone: step.onDone.map((entry) => {
        const spec = branch(entry);
        return {
          target: spec.to,
          ...(spec.when ? { cond: spec.when } : {}),
          actions: assign((context, event) => {
            if (spec.message) emit(context, callMessage(spec, context, event));
            if (spec.set) spec.set(context, event);
          })
        };
      }),
      onError: { target: step.onError || '#system_error' }
    }
  })
};

function place(root, step, wrappers) {
  let states = root;
  let parent = null;
  const prefix = [];
  for (const name of step.path || []) {
    prefix.push(name);
    if (!states[name]) states[name] = { ...(wrappers[prefix.join('.')] || {}), states: {} };
    parent = states[name];
    states = parent.states;
  }
  states[step.key] = emitters[step.kind](step);
  if (step.first && parent) parent.initial = step.key;
}

function generate(steps, wrappers = {}) {
  const root = {};
  for (const step of steps) {
    if (!emitters[step.kind]) throw new Error(`flow: step '${step.key}' has unknown kind '${step.kind}'`);
    place(root, step, wrappers);
  }
  return root;
}

function targetsOf(node) {
  const found = [];
  const collect = (value) => {
    if (typeof value === 'string') found.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') collect(value.target);
  };
  collect(node.always);
  for (const event of Object.keys(node.on || {})) collect(node.on[event]);
  collect(node.invoke && node.invoke.onDone);
  collect(node.invoke && node.invoke.onError);
  return found;
}

function scan(node, out, name = '(root)') {
  if (!node || typeof node !== 'object') return out;
  if (typeof node.id === 'string') out.ids.push(node.id);
  for (const target of targetsOf(node)) if (target.startsWith('#')) out.targets.push(target);
  const children = Object.keys(node.states || {});
  if (children.length && !node.initial && name !== '(root)') out.headless.push(name);
  for (const child of children) scan(node.states[child], out, child);
  return out;
}

function assertTargets(states, allowed = []) {
  const out = scan({ states }, { ids: [], targets: [], headless: [] });
  const duplicate = out.ids.find((id, index) => out.ids.indexOf(id) !== index);
  if (duplicate) throw new Error(`flow: duplicate state id '#${duplicate}'`);
  const known = new Set(out.ids.concat(allowed));
  const missing = out.targets.find((target) => !known.has(target.slice(1)));
  if (missing) throw new Error(`flow: unknown transition target '${missing}'`);
  if (out.headless.length) throw new Error(`flow: compound state '${out.headless[0]}' has no initial state`);
  return states;
}

function mergeStates(target, source) {
  for (const key of Object.keys(source)) {
    const incoming = source[key];
    const existing = target[key];
    if (existing && incoming.states && existing.states) {
      for (const field of Object.keys(incoming)) {
        if (field !== 'states') existing[field] = incoming[field];
      }
      mergeStates(existing.states, incoming.states);
    } else {
      target[key] = incoming;
    }
  }
  return target;
}

module.exports = { generate, assertTargets, mergeStates };
