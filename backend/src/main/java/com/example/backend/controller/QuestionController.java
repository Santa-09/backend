package com.example.backend.controller;

import com.example.backend.model.Question;
import com.example.backend.model.Reply;
import com.example.backend.service.QuestionService;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/questions")
public class QuestionController {

    private final QuestionService questionService;

    public QuestionController(QuestionService questionService) {
        this.questionService = questionService;
    }

    @GetMapping
    public List<Question> getAllQuestions() {
        return questionService.getAllQuestions();
    }

    @PostMapping
    public Question createQuestion(@RequestBody QuestionRequest request) {
        return questionService.createQuestion(request.getText());
    }

    @PostMapping("/{questionId}/replies")
    public Reply addReply(@PathVariable String questionId, @RequestBody ReplyRequest request) {
        return questionService.addReply(questionId, request.getText());
    }

    @DeleteMapping("/{id}")
    public void deleteQuestion(@PathVariable String id) {
        questionService.deleteQuestion(id);
    }

    @DeleteMapping("/{questionId}/replies/{replyId}")
    public void deleteReply(@PathVariable String questionId, @PathVariable String replyId) {
        questionService.deleteReply(questionId, replyId);
    }

    @DeleteMapping
    public void clearAllQuestions() {
        questionService.clearAllQuestions();
    }

    public static class QuestionRequest {
        private String text;
        public String getText() { return text; }
        public void setText(String text) { this.text = text; }
    }

    public static class ReplyRequest {
        private String text;
        public String getText() { return text; }
        public void setText(String text) { this.text = text; }
    }
}
