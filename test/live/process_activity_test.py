import importlib.util
import pathlib
import platform
import unittest
from unittest.mock import patch

path = pathlib.Path(__file__).resolve().parents[2] / "scripts/live/process_activity.py"
spec = importlib.util.spec_from_file_location("process_activity", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ProcessActivityTests(unittest.TestCase):
    def test_does_not_disable_system_or_display_idle_sleep(self):
        self.assertEqual(module.USER_INITIATED_ALLOWING_IDLE_SLEEP & ((1 << 20) | (1 << 40)), 0)

    def test_non_mac_and_unavailable_framework_keep_previous_behavior(self):
        with patch.object(module.platform, "system", return_value="Linux"):
            activity = module.ProcessActivity()
            self.assertFalse(activity.begin())
            activity.end()
        with patch.object(module.platform, "system", return_value="Darwin"), patch.object(module.ProcessActivity, "_load", side_effect=OSError):
            self.assertFalse(module.ProcessActivity().begin())

    @unittest.skipUnless(platform.system() == "Darwin", "macOS API")
    def test_native_activity_is_balanced_and_reusable(self):
        activity = module.ProcessActivity()
        try:
            self.assertTrue(activity.begin())
            token = activity._token
            self.assertTrue(activity.begin())
            self.assertEqual(activity._token, token)
            activity.end()
            self.assertFalse(activity.active)
            activity.end()
            self.assertTrue(activity.begin())
        finally:
            activity.end()


if __name__ == "__main__":
    unittest.main()
