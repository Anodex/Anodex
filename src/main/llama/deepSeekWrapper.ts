import type { ChatWrapperSettings } from 'node-llama-cpp'
import {
  DEEPSEEK_CALLS_BEGIN,
  DEEPSEEK_CALLS_END,
  DEEPSEEK_CALL_BEGIN,
  DEEPSEEK_CALL_END,
  DEEPSEEK_SEP,
  DEEPSEEK_OUTPUTS_BEGIN,
  DEEPSEEK_OUTPUTS_END,
  DEEPSEEK_OUTPUT_BEGIN,
  DEEPSEEK_OUTPUT_END
} from '@shared/deepSeekMarkers'

type NlcModule = typeof import('node-llama-cpp')

/**
 * A chat wrapper that keeps DeepSeek's own Jinja prompt but teaches
 * node-llama-cpp the tool-call syntax that prompt makes the model emit.
 *
 * Split out of `LlamaService.toolCallingWrapper` to be testable on its own: the
 * bug this exists to prevent lives entirely in which marker sits in which
 * setting, and that is checkable without loading a model.
 */
export function buildDeepSeekChatWrapper(
  nlc: NlcModule,
  template: string
): InstanceType<NlcModule['JinjaTemplateChatWrapper']> {
  // `functionCallMessageTemplate` describes one call, so the per-call markers
  // go here and the section markers do not. Folding the section into the call
  // template — which is what this did first — makes
  // `<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>` the prefix node-llama-cpp
  // matches to recognise a call. DeepSeek opens the section once and starts
  // every later call with the bare `<｜tool▁call▁begin｜>`, so only the first
  // call in a section was ever recognised; the rest arrived as prose, and
  // since generation no longer stopped at the boundary the model wrote their
  // results too. One live turn leaked eight calls that way, inventing an
  // `edit_file` success and a web server on port 8000 while changing nothing.
  const wrapper = new nlc.JinjaTemplateChatWrapper({
    template,
    functionCallMessageTemplate: {
      call: `${DEEPSEEK_CALL_BEGIN}function${DEEPSEEK_SEP}{{functionName}}\n\`\`\`json\n{{functionParams}}\n\`\`\`${DEEPSEEK_CALL_END}`,
      result: `${DEEPSEEK_OUTPUT_BEGIN}{{functionCallResult}}${DEEPSEEK_OUTPUT_END}`
    }
  })

  const functions = wrapper.settings.functions
  if (functions == null) return wrapper

  // The sections themselves, which `functionCallMessageTemplate` has no way to
  // express — node-llama-cpp reads them off `settings` directly. Declaring them
  // is what closes a section properly in the rendered context once a call has
  // run (`sectionSuffix`, then the results section).
  //
  // `betweenCalls` is empty because DeepSeek concatenates calls directly. The
  // one-call-per-section bound stays as it was — see `maxParallelFunctionCalls`
  // in `generate()`'s prompt options for why buffering a whole section before
  // executing anything is unsafe here.
  //
  // Assigned onto the instance rather than passed in: `settings` is declared
  // readonly and the constructor takes no parallelism option, but the wrapper
  // is a live object whose methods read `this.settings`, so replacing the
  // whole object is the only way to keep both its prototype and its parsing.
  const settings: ChatWrapperSettings = {
    ...wrapper.settings,
    functions: {
      ...functions,
      parallelism: {
        call: {
          sectionPrefix: DEEPSEEK_CALLS_BEGIN,
          // The section opener is written once per turn and then never again:
          // after a result comes back, DeepSeek-Coder-V2-Lite resumes with a
          // bare `<｜tool▁call▁begin｜>`. node-llama-cpp detects a call by the
          // section prefix and the call prefix *concatenated*, so without an
          // empty alternate every call after the first fails to match and
          // arrives as prose — measured directly by the live probe, which saw
          // `list_files` execute and the `read_file` that depended on its
          // result leak as text, followed by an invented file listing.
          //
          // Detection only: node-llama-cpp still writes the canonical
          // `sectionPrefix` when it builds the context itself.
          sectionPrefixAlternateMatches: [''],
          betweenCalls: '',
          sectionSuffix: DEEPSEEK_CALLS_END
        },
        result: {
          sectionPrefix: DEEPSEEK_OUTPUTS_BEGIN,
          betweenResults: '',
          sectionSuffix: DEEPSEEK_OUTPUTS_END
        }
      }
    }
  }
  Object.assign(wrapper, { settings })
  return wrapper
}
