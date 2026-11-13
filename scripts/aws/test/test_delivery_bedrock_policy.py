"""The delivery Bedrock policy (P7) stays EU-only and minimal.

Lane agentic-delivery-scope/bedrock-invoke-policy. The policy gives a Kiro session role the Bedrock invoke rights of the
delivery model chains: M1 sparring and M4 review (Opus 5.5, Sonnet 5.5, Opus 4.6, Sonnet 4.6) and M5 vision (Opus 4.6),
through the EU geo inference profiles, plus DeepSeek V3.2 in eu-north-1 (option A, off in config). The six Regions are
the destination Regions `aws bedrock get-inference-profile` lists for each of the four EU profiles (2026-11-12).
"""
import json
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[3]
POLICY = ROOT / 'scripts/aws/iam/delivery-bedrock-invoke-policy.json'
ACCOUNT = '472838866351'
EU_REGIONS = {'eu-central-1', 'eu-north-1', 'eu-south-1', 'eu-south-2', 'eu-west-1', 'eu-west-3'}
CHAIN_MODELS = [
    'anthropic.claude-opus-5-5',
    'anthropic.claude-sonnet-5-5',
    'anthropic.claude-opus-4-6-v1',
    'anthropic.claude-sonnet-4-6',
]
ACTIONS = {'bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'}
DEEPSEEK = 'arn:aws:bedrock:eu-north-1::foundation-model/deepseek.v3.2'
PROFILES = {f'arn:aws:bedrock:eu-central-1:{ACCOUNT}:inference-profile/eu.{m}' for m in CHAIN_MODELS}
MODELS = {f'arn:aws:bedrock:{r}::foundation-model/{m}' for r in EU_REGIONS for m in CHAIN_MODELS}


class DeliveryBedrockPolicy(unittest.TestCase):
    def setUp(self):
        self.assertTrue(POLICY.exists(), f'{POLICY.relative_to(ROOT)} is missing')
        self.doc = json.loads(POLICY.read_text())
        self.statements = self.doc['Statement']
        self.resources = [r for s in self.statements for r in s['Resource']]

    def test_version_and_allow_only(self):
        self.assertEqual(self.doc['Version'], '2012-10-17')
        for s in self.statements:
            self.assertEqual(s['Effect'], 'Allow')
            for key in ('NotAction', 'NotResource', 'Principal'):
                self.assertNotIn(key, s)

    def test_actions_are_invoke_only(self):
        for s in self.statements:
            self.assertEqual(set(s['Action']), ACTIONS, s['Sid'])

    def test_no_wildcard_and_no_duplicate(self):
        for r in self.resources:
            self.assertNotIn('*', r)
        self.assertEqual(len(self.resources), len(set(self.resources)))

    def test_every_resource_is_in_an_eu_destination_region(self):
        for r in self.resources:
            self.assertIn(r.split(':')[3], EU_REGIONS, r)

    def test_chain_profiles_are_in_frankfurt(self):
        self.assertLessEqual(PROFILES, set(self.resources))

    def test_each_chain_model_is_allowed_in_all_six_regions(self):
        self.assertLessEqual(MODELS, set(self.resources))

    def test_deepseek_only_in_stockholm(self):
        self.assertEqual([r for r in self.resources if 'deepseek' in r], [DEEPSEEK])

    def test_nothing_else_is_allowed(self):
        self.assertEqual(set(self.resources), PROFILES | MODELS | {DEEPSEEK})


if __name__ == '__main__':
    unittest.main()
