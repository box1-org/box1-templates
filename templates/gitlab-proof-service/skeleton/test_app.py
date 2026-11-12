import unittest

import app


class InfoTest(unittest.TestCase):
    def test_info_names_the_service(self):
        self.assertEqual(app.info()["service"], "${{ values.name }}")

    def test_message_is_set(self):
        self.assertTrue(app.info()["message"])


if __name__ == "__main__":
    unittest.main()
