require("dotenv").config();
const express = require("express");
const axios = require("axios");
const Joi = require("joi");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const pdf = require("pdf-parse");
const mammoth = require("mammoth");
const { createWorker } = require("tesseract.js");
const OpenAI = require("openai");

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({
    baseURL: 'https://api.aimlapi.com/v1',
    apiKey: process.env.AIML_API_KEY
});

// Rate limiting (10 requests/min)
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
});
app.use("/api/parse", limiter);

// File upload middleware
const upload = multer({ storage: multer.memoryStorage() });

// --- Helper Functions ---
async function extractTextFromPDF(buffer) {
  const data = await pdf(buffer);
  return data.text;
}

async function extractTextFromDOCX(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

async function extractTextFromImage(buffer) {
  const worker = await createWorker();
  await worker.loadLanguage("eng");
  await worker.initialize("eng");
  const { data } = await worker.recognize(buffer);
  await worker.terminate();
  return data.text;
}

// --- DeepSeek API Call ---
async function callOpenAIAPI(resumeText) {
  // console.log("resumeText ", resumeText);

  const prompt = `
    Parse this resume into strict JSON with:
    - personal_info (name, email, phone, linkedin,languages)
    - education (degree, university, year)
    - work_experience (job_title, company, duration, responsibilities[])
    - skills (technical[], soft[])
    - certifications [{ name, issuer, year }]
    - projects [{ title,technology,time_period }]
    
    Automatic spam detection (missing fields, gibberish, fake formatting, all fields which are present are check with proper valid validation and placeholder patterns ) on the basis of it check it's spam or not.
    Also check that year start and year end is a valid year and the email address so be valid email address and also the number is in correct format according to the country/address they live.
    Return ONLY valid JSON Object without markdown and not give any other information and no improvement text and no parsed line only JSON object and not any single quotes , double quotes and back-tick at the end or starting of object but JSON keys are always in double quotes.
    And if the resume is spam then mark it spam:true otherwise false and give it inside object.
    Resume Text: ${resumeText}
  `;
// Also add backtick at starting and ending of response
// if the resume is spam then mark it spam:true otherwise false, 
// make it proper JSON formate object without any error
  const completion = await openai.chat.completions.create({
    // model: "mistralai/Mistral-7B-Instruct-v0.2",
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 1500,
    temperature: 0.7,
  });
  
  const response = completion.choices[0].message.content;
  console.log(typeof response,"And text ",response);
  return JSON.parse(response);

}

// --- Routes ---
app.post("/api/parse", upload.single("resume"), async (req, res) => {
  try {
    if (!req.file) throw new Error("No file uploaded.");

    let text;
    const fileType = req.file.mimetype;
    // Extract text based on file type
    if (fileType === "application/pdf") {
      text = await extractTextFromPDF(req.file.buffer);
    } else if (
      fileType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      text = await extractTextFromDOCX(req.file.buffer);
    } else if (fileType.startsWith("image/")) {
      text = await extractTextFromImage(req.file.buffer);
    } else {
      throw new Error("Unsupported file type.");
    }

    // Call DeepSeek API for JSON parsing
    const parsedResume = await callOpenAIAPI(text);

    // Validate JSON schema
    const schema = Joi.object({
      personal_info: Joi.object({
        name: Joi.string(),
        email: Joi.string().email(),
        phone: Joi.string(),
        linkedin: Joi.string(),
        languages: Joi.string()
      }).required(),
      education: Joi.array().items(
        Joi.object({
          degree: Joi.string(),
          university: Joi.string(),
          year: Joi.string()
        })
      ),
      work_experience: Joi.array().items(
        Joi.object({
          job_title: Joi.string(),
          company: Joi.string(),
          duration: Joi.string(),
          responsibilities: Joi.array().items(Joi.string())
        })
      ),
      skills: Joi.object({
        technical: Joi.array().items(Joi.string()),
        soft: Joi.array().items(Joi.string()),
      }),
      certifications: Joi.array().items(Joi.object({
        name: Joi.string(),
        issuer: Joi.string(),
        year: Joi.any()
      })),
      projects: Joi.array().items(Joi.object({
        title: Joi.string(),
        technology: Joi.string(),
        time_period: Joi.any()
      })),
      spam: Joi.boolean()
    });

    // const { error } = schema.validate(parsedResume);
    // if (error) throw new Error(`Validation failed: ${error.message}`);
    if(parsedResume.spam == "true" || parsedResume.spam == true){
      res.json({spanResume: "⚠️ This resume may be spam or incomplete or Valid resume required"});
    }else{
      res.json(parsedResume);
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({error : "Insert proper resume, Valid resume required" });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
