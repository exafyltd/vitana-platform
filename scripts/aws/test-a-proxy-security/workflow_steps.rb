# Read-only queries over a workflow file, used by the offline tests.
#
# Usage:
#   ruby workflow_steps.rb <workflow.yml> steps              # step names of the job, in order (JSON)
#   ruby workflow_steps.rb <workflow.yml> job-env            # job env (JSON)
#   ruby workflow_steps.rb <workflow.yml> step <name>        # one step (JSON); exits 1 if missing
#   ruby workflow_steps.rb <workflow.yml> run <name> <file>  # write one step's run block to <file>
#   ruby workflow_steps.rb <workflow.yml> job-if <job>       # the job's if (JSON, null when absent)
#   ruby workflow_steps.rb <workflow.yml> job-needs <job>    # the job's needs as a list (JSON)
#
# The job for steps, step, run and job-env is named by the env var WF_JOB, and defaults to JOB.
# A run block is written with ${{ ... }} expressions replaced by fixed test values. An expression
# that has no test value stops the extraction, so a new expression cannot be skipped silently.
require 'yaml'
require 'json'

JOB = 'build-push-deploy'.freeze

# Test values for expressions that appear in run blocks. They mirror the workflow defaults.
SUBSTITUTIONS = {
  'env.ECS_CLUSTER' => 'Vitana-ECS-Cluster',
  'env.ECS_SERVICE' => 'vitana-postgrest-aurora-proxy',
  'env.PROXY_CONTAINER' => 'proxy',
  'env.ECR_REPOSITORY' => 'vitana/postgrest-aurora-proxy',
  'env.DEPLOY_REASON' => 'offline test',
  'env.TARGET_AWS_REGION' => 'eu-central-1',
  'steps.build.outputs.image' =>
    '472838866351.dkr.ecr.eu-central-1.amazonaws.com/vitana/postgrest-aurora-proxy:staging-test'
}.freeze

wf_path, cmd, *rest = ARGV.map { |arg| arg.dup.force_encoding('UTF-8') }
jobs = YAML.load_file(wf_path).fetch('jobs')

named_job = lambda do |name|
  jobs.fetch(name) { abort("no job named #{name.inspect}") }
end
current_job = -> { named_job.call(ENV.fetch('WF_JOB', JOB)) }
steps = -> { current_job.call.fetch('steps', []) }

find_step = lambda do |name|
  steps.call.find { |step| step['name'] == name } || abort("no step named #{name.inspect}")
end

case cmd
when 'steps'
  puts steps.call.map { |step| step['name'] || step['uses'] }.to_json
when 'job-env'
  puts current_job.call.fetch('env').to_json
when 'job-if'
  puts named_job.call(rest[0]).fetch('if', nil).to_json
when 'job-needs'
  puts Array(named_job.call(rest[0]).fetch('needs', nil)).to_json
when 'step'
  puts find_step.call(rest[0]).to_json
when 'run'
  body = find_step.call(rest[0]).fetch('run') { abort("step #{rest[0].inspect} has no run block") }
  body = body.gsub(/\$\{\{\s*(.+?)\s*\}\}/) do
    key = Regexp.last_match(1)
    SUBSTITUTIONS.fetch(key) { abort("no test value for expression ${{ #{key} }}") }
  end
  File.write(rest[1], body)
else
  abort("unknown command #{cmd.inspect}")
end
