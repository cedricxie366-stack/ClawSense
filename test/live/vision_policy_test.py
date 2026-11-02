import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("vision_policy", Path(__file__).resolve().parents[2] / "scripts/live/vision_policy.py")
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class VisionPolicyTest(unittest.TestCase):
    def test_dark_and_blank_images_do_not_offer_object_guesses(self):
        self.assertIn("太暗", policy.quality_message(.004, .001, .005))
        self.assertIn("细节不足", policy.quality_message(.99, .001, 1.0))
        self.assertIn("比较", policy.quality_message(.004, .001, .005, 2))
        self.assertIsNone(policy.quality_message(.5, .2, .9))

    def test_overview_drops_unsolicited_details_without_relabeling_subject(self):
        self.assertEqual(policy.scoped_description("一个玻璃杯，里面装着棕色物体。", "我现在正在看什么？", 1), "一个玻璃杯。")
        self.assertEqual(policy.scoped_description("一个玻璃水壶，壶嘴朝下。", "现在看到了什么？", 1), "一个玻璃水壶。")
        self.assertIn("不能可靠", policy.scoped_description("一个盛有液体的容器。", "我在看什么？", 1))

    def test_detail_and_two_frame_questions_keep_their_actual_answer(self):
        for query in ["是什么颜色？", "画面有什么形状和颜色？", "里面是什么？", "照片里有什么变化？"]:
            self.assertFalse(policy.overview_question(query))
        text = "第一张有圆形，第二张没有。"
        self.assertEqual(policy.scoped_description(text, "画面有什么变化？", 2), text)


if __name__ == "__main__":
    unittest.main()
